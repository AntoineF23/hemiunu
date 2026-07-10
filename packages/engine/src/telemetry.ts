// OpenTelemetry wiring for the engine. All of it is a NO-OP unless the operator
// opts in (HEMIUNU_OTEL=1 or an OTEL_EXPORTER_OTLP endpoint is set), so default
// users pay nothing. When enabled, the loop (loop.ts) wraps each turn/step/tool
// in spans and the AI SDK emits GenAI model spans via `experimental_telemetry`;
// they all flow to the operator's own collector over the standard OTLP env
// contract — so a teammate who runs Hemiunu sees its traces in the observability
// stack they already have.
//
// Two privacy guarantees baked in (see the plan): the actor is PSEUDONYMOUS (no
// host/user identity on the resource — just a random, persisted instance id),
// and a redacting exporter scrubs secrets (and optionally PII) out of recorded
// prompt/output content on the way out.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { type Attributes, type Span, type Context, context, trace } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
} from "@opentelemetry/sdk-trace-base";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

const TRACER_NAME = "hemiunu";

/** Hemiunu config dir (mirrors config elsewhere; kept local to avoid a cycle). */
function configDir(): string {
  return process.env.HEMIUNU_CONFIG_DIR ?? join(homedir(), ".hemiunu");
}

/**
 * Telemetry is on when explicitly enabled, or when the operator has pointed us
 * at a collector via the standard OTLP endpoint envs. Off ⇒ every helper below
 * is a no-op and no OTel SDK is started.
 */
export function telemetryEnabled(): boolean {
  const flag = process.env.HEMIUNU_OTEL?.trim().toLowerCase();
  if (flag === "0" || flag === "false" || flag === "off") return false;
  if (flag === "1" || flag === "true" || flag === "on") return true;
  return !!(
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() ||
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT?.trim()
  );
}

/** Whether prompt/output CONTENT is recorded on spans (default: yes). */
export function recordContent(): boolean {
  const v = process.env.HEMIUNU_OTEL_RECORD_CONTENT?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off");
}

// ---------------------------------------------------------------------------
// Redaction — scrub secrets (always) and optionally PII from recorded content.
// ---------------------------------------------------------------------------

export type RedactLevel = "off" | "secrets" | "pii" | "all";

export function redactLevel(): RedactLevel {
  const v = process.env.HEMIUNU_OTEL_REDACT?.trim().toLowerCase();
  if (v === "off" || v === "pii" || v === "all") return v;
  return "secrets"; // default: keep content, strip keys/tokens
}

const MASK = "«redacted»";

// Common secret shapes: provider keys (sk-…, various vendor prefixes), bearer
// tokens, and long high-entropy blobs (base64/hex ≥ 40 chars).
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:sk|rk|pk)-[A-Za-z0-9_-]{16,}\b/g,
  /\b(?:xai|gsk|AIza|ghp|gho|glpat)[A-Za-z0-9_-]{16,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{12,}\b/gi,
  /\b[A-Fa-f0-9]{40,}\b/g,
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/g,
];
const PII_PATTERNS: RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, // email
  /\b\+?\d[\d\s().-]{7,}\d\b/g, // phone-ish
];

function customPatterns(): RegExp[] {
  const raw = process.env.HEMIUNU_OTEL_REDACT_PATTERNS?.trim();
  if (!raw) return [];
  return raw
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((src) => {
      try {
        return [new RegExp(src, "g")];
      } catch {
        return []; // ignore a malformed pattern rather than crash a turn
      }
    });
}

/** Redact a string per the active level. `all` and unknown non-strings are
 *  handled by callers; this operates on text. */
export function redact(text: string, level: RedactLevel = redactLevel()): string {
  if (level === "off") return text;
  let out = text;
  for (const re of [...SECRET_PATTERNS, ...customPatterns()]) out = out.replace(re, MASK);
  if (level === "pii" || level === "all")
    for (const re of PII_PATTERNS) out = out.replace(re, MASK);
  return out;
}

/** Content attribute keys the redactor sweeps on export — the AI SDK's GenAI
 *  keys AND our own hemiunu.tool.input / hemiunu.tool.result / *.text. */
const CONTENT_ATTR_RE =
  /prompt|completion|response\.text|input\.value|output\.value|\.content|\.text\b|hemiunu\.tool\.(input|result)/i;

/**
 * In-place redact the content attributes of one span's attribute bag per the
 * active level: `all` masks them wholesale, others run the secret/PII redactor
 * over string values whose key looks like content. Non-content keys (ids,
 * usage, model, decision…) are left untouched. Exported for testing.
 */
export function redactSpanAttributes(
  attrs: Record<string, unknown>,
  level: RedactLevel = redactLevel(),
): void {
  if (level === "off") return;
  for (const key of Object.keys(attrs)) {
    if (!CONTENT_ATTR_RE.test(key)) continue;
    const val = attrs[key];
    if (typeof val !== "string") continue;
    attrs[key] = level === "all" ? MASK : redact(val, level);
  }
}

/** A SpanExporter that redacts content attributes (ours AND the AI SDK's) before
 *  delegating to the real OTLP exporter. `all` drops content attributes entirely. */
class RedactingExporter implements SpanExporter {
  constructor(private inner: SpanExporter) {}
  export(spans: ReadableSpan[], done: (r: { code: number; error?: Error }) => void): void {
    const level = redactLevel();
    if (level !== "off") {
      for (const span of spans)
        redactSpanAttributes(span.attributes as Record<string, unknown>, level);
    }
    // The inner exporter's callback type is structurally the same shape.
    (this.inner.export as unknown as (s: ReadableSpan[], cb: typeof done) => void)(spans, done);
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

// ---------------------------------------------------------------------------
// Actor pseudonymity — a stable, random instance id (not tied to a person).
// ---------------------------------------------------------------------------

/** A random UUID persisted per install; identifies the agent instance for team
 *  grouping without revealing who runs it. Overridable via HEMIUNU_OTEL_ACTOR. */
export function actorId(): string {
  const override = process.env.HEMIUNU_OTEL_ACTOR?.trim();
  if (override) return override;
  const path = join(configDir(), "otel-instance-id");
  try {
    if (existsSync(path)) return readFileSync(path, "utf8").trim() || writeActor(path);
    return writeActor(path);
  } catch {
    return "anonymous";
  }
}

function writeActor(path: string): string {
  const id = randomUUID();
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(path, `${id}\n`, "utf8");
  return id;
}

// ---------------------------------------------------------------------------
// SDK lifecycle.
// ---------------------------------------------------------------------------

let sdk: NodeSDK | undefined;
let started = false;

/** True if a real (non-proxy/noop) TracerProvider is already registered by a
 *  host process embedding us — then we must NOT override it. */
function hostProviderPresent(): boolean {
  const p = trace.getTracerProvider() as { constructor?: { name?: string } };
  const name = p?.constructor?.name ?? "";
  // The default global is a ProxyTracerProvider delegating to a Noop; anything
  // else means a host set up its own provider.
  return name !== "" && name !== "ProxyTracerProvider" && name !== "NoopTracerProvider";
}

/**
 * Start the OTel SDK once, if enabled and no host provider exists. Idempotent —
 * safe to call from both the CLI and web entrypoints. Reads the standard OTLP
 * env (endpoint, headers, protocol, service name) so it targets whatever
 * collector the operator already runs.
 */
export function initTelemetry(): void {
  if (started || !telemetryEnabled()) return;
  started = true;
  if (hostProviderPresent()) return; // respect the embedding app's OTel

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: process.env.OTEL_SERVICE_NAME?.trim() || TRACER_NAME,
    [ATTR_SERVICE_VERSION]: process.env.HEMIUNU_VERSION?.trim() || "0.0.0",
    // Pseudonymous actor — deliberately NO host.name / process.owner / os.user.
    "service.instance.id": actorId(),
  });

  const exporter = new RedactingExporter(new OTLPTraceExporter());
  sdk = new NodeSDK({
    resource,
    spanProcessors: [new BatchSpanProcessor(exporter)],
    // No auto-instrumentations and no resource detectors: we don't want HTTP/fs
    // noise, and detectors would re-introduce host/user identity.
  });
  sdk.start();
}

/** Flush and stop the SDK. Essential for the short-lived CLI process, or spans
 *  buffered in the batch processor are lost on exit. Safe when never started. */
export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  try {
    await sdk.shutdown();
  } catch {
    // best-effort on exit
  } finally {
    sdk = undefined;
    started = false;
  }
}

// ---------------------------------------------------------------------------
// Span helpers used by the loop — all no-ops when telemetry is off.
// ---------------------------------------------------------------------------

export function getTracer() {
  return trace.getTracer(TRACER_NAME);
}

/** Start a span as a child of `parent` (or the active context). Returns
 *  undefined when telemetry is off, so callers stay branch-free. */
export function startSpan(
  name: string,
  attributes?: Attributes,
  parent?: Context,
): Span | undefined {
  if (!telemetryEnabled()) return undefined;
  return getTracer().startSpan(name, { attributes }, parent ?? context.active());
}

/** Context with `span` active, for parenting child spans / AI-SDK model spans. */
export function ctxWith(span: Span | undefined, base: Context = context.active()): Context {
  return span ? trace.setSpan(base, span) : base;
}

/** Redact a content value for a span attribute, honoring the record-content and
 *  redaction settings. Returns undefined when content recording is off. */
export function contentAttr(value: string | undefined): string | undefined {
  if (value == null || !recordContent()) return undefined;
  return redact(value);
}

export { context as otelContext, trace as otelTrace };
