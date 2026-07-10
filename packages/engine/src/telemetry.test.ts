import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  actorId,
  contentAttr,
  recordContent,
  redact,
  redactLevel,
  redactSpanAttributes,
  startSpan,
  telemetryEnabled,
} from "./telemetry";

// Snapshot + restore the env keys these tests mutate.
const KEYS = [
  "HEMIUNU_OTEL",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "HEMIUNU_OTEL_RECORD_CONTENT",
  "HEMIUNU_OTEL_REDACT",
  "HEMIUNU_OTEL_ACTOR",
  "HEMIUNU_CONFIG_DIR",
] as const;
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];
function clearEnv() {
  for (const k of KEYS) delete process.env[k];
}
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

test("telemetryEnabled: off by default, on via flag or OTLP endpoint", () => {
  clearEnv();
  assert.equal(telemetryEnabled(), false);
  process.env.HEMIUNU_OTEL = "1";
  assert.equal(telemetryEnabled(), true);
  process.env.HEMIUNU_OTEL = "off";
  assert.equal(telemetryEnabled(), false); // explicit off wins over endpoint
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT = "http://localhost:4318";
  assert.equal(telemetryEnabled(), false);
  delete process.env.HEMIUNU_OTEL;
  assert.equal(telemetryEnabled(), true); // endpoint alone enables
});

test("startSpan + contentAttr are no-ops when telemetry is off", () => {
  clearEnv();
  assert.equal(startSpan("hemiunu.turn", { a: 1 }), undefined);
  // contentAttr still records (redaction/content flag is independent of enable).
  assert.equal(recordContent(), true);
});

test("recordContent: default on, off via env; contentAttr honors it", () => {
  clearEnv();
  assert.equal(contentAttr("hello"), "hello");
  process.env.HEMIUNU_OTEL_RECORD_CONTENT = "0";
  assert.equal(recordContent(), false);
  assert.equal(contentAttr("hello"), undefined);
});

test("redact: secrets masked at default level; content otherwise kept", () => {
  clearEnv();
  assert.equal(redactLevel(), "secrets");
  const out = redact("call with sk-abcdef0123456789ABCDEF and hi");
  assert.doesNotMatch(out, /sk-abcdef0123456789/);
  assert.match(out, /hi/); // ordinary content survives
  assert.match(out, /call with/);
});

test("redact: pii level also masks emails; off leaves everything", () => {
  assert.match(redact("ping me at jane@acme.com", "off"), /jane@acme\.com/);
  assert.doesNotMatch(redact("ping me at jane@acme.com", "pii"), /jane@acme\.com/);
  // secrets level does NOT touch a plain email
  assert.match(redact("ping me at jane@acme.com", "secrets"), /jane@acme\.com/);
});

test("redactSpanAttributes: sweeps content keys, leaves non-content keys", () => {
  const attrs: Record<string, unknown> = {
    "gen_ai.prompt": "here is my key sk-abcdef0123456789ABCDEF",
    "hemiunu.tool.result": "token Bearer abcdefghijkl",
    "hemiunu.model": "claude-opus-4.8", // not content — must be untouched
    "hemiunu.usage.input_tokens": 1234, // non-string — untouched
  };
  redactSpanAttributes(attrs, "secrets");
  assert.doesNotMatch(attrs["gen_ai.prompt"] as string, /sk-abcdef/);
  assert.doesNotMatch(attrs["hemiunu.tool.result"] as string, /Bearer abcdefghijkl/);
  assert.equal(attrs["hemiunu.model"], "claude-opus-4.8");
  assert.equal(attrs["hemiunu.usage.input_tokens"], 1234);

  const dropped: Record<string, unknown> = { "gen_ai.completion": "anything at all" };
  redactSpanAttributes(dropped, "all");
  assert.notEqual(dropped["gen_ai.completion"], "anything at all");
});

test("actorId: persists a stable random id; env override wins", () => {
  clearEnv();
  const dir = mkdtempSync(join(tmpdir(), "hemiunu-otel-"));
  process.env.HEMIUNU_CONFIG_DIR = dir;
  const first = actorId();
  assert.match(first, /[0-9a-f-]{36}/); // a UUID
  assert.equal(actorId(), first, "stable across calls");
  assert.ok(existsSync(join(dir, "otel-instance-id")));
  assert.equal(readFileSync(join(dir, "otel-instance-id"), "utf8").trim(), first);

  process.env.HEMIUNU_OTEL_ACTOR = "team-alpha";
  assert.equal(actorId(), "team-alpha", "explicit pseudonym overrides the id");
});
