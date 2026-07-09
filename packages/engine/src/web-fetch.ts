// web_fetch — the engine's owned page-fetch tool, always available (no key or
// provider needed). Fetches a URL with undici (Node's global fetch), extracts
// the readable article with @mozilla/readability over a linkedom DOM, and
// converts it to markdown with turndown. Output is truncation-capped.
//
// SSRF guard: only http(s) URLs; the hostname is DNS-resolved and EVERY
// address must be public (loopback, RFC1918, link-local, CGNAT, unique-local,
// multicast/reserved ranges are all blocked); redirects are followed manually
// and every hop is re-checked, so a public page can't bounce the agent into a
// private range (cloud metadata endpoints, localhost services, …).

import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import TurndownService from "turndown";
import { z } from "zod";
import type { HemiTool } from "./tool";

export interface WebFetchOptions {
  /** Fetch override (tests); default global fetch (undici). */
  fetchImpl?: typeof fetch;
  /** DNS override (tests); default node:dns lookup (all addresses). */
  lookup?: (hostname: string) => Promise<Array<{ address: string }>>;
  /** Cap on the returned markdown, in characters. */
  maxContentChars?: number;
  /** Max redirect hops before giving up. */
  maxRedirects?: number;
  /** Per-request timeout. */
  timeoutMs?: number;
}

const DEFAULT_MAX_CONTENT_CHARS = 100_000;
const DEFAULT_MAX_REDIRECTS = 5;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Hard cap on raw bytes read off the wire before extraction. */
const MAX_BODY_CHARS = 4_000_000;

// --- SSRF guard ---------------------------------------------------------------

/**
 * True when an IP literal must never be fetched: loopback, RFC1918 private,
 * link-local (incl. cloud metadata 169.254.169.254), CGNAT, IETF-reserved,
 * benchmarking, multicast and above — and their IPv6 equivalents (::1,
 * fc00::/7, fe80::/10, v4-mapped). Unparseable input is treated as private.
 */
export function isPrivateAddress(ip: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPrivateAddress(mapped[1]);
  if (ip.includes(":")) {
    const v6 = ip.toLowerCase();
    if (v6 === "::" || v6 === "::1") return true;
    if (/^f[cd]/.test(v6)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(v6)) return true; // fe80::/10 link-local
    return false;
  }
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // unspecified, RFC1918, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local / metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918 172.16/12
  if (a === 192 && b === 168) return true; // RFC1918 192.168/16
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

const defaultLookup = (hostname: string) => dnsLookup(hostname, { all: true });

/** Throw unless the URL is http(s) and resolves ONLY to public addresses. */
async function assertPublicHttpUrl(
  url: URL,
  lookup: (hostname: string) => Promise<Array<{ address: string }>>,
): Promise<void> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Blocked: only http(s) URLs can be fetched (got ${url.protocol}//).`);
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isIP(hostname)) {
    if (isPrivateAddress(hostname)) {
      throw new Error(`Blocked: ${hostname} is a private/loopback/link-local address.`);
    }
    return;
  }
  let addresses: Array<{ address: string }>;
  try {
    addresses = await lookup(hostname);
  } catch {
    throw new Error(`Could not resolve host '${hostname}'.`);
  }
  if (!addresses.length) throw new Error(`Could not resolve host '${hostname}'.`);
  for (const { address } of addresses) {
    if (isPrivateAddress(address)) {
      throw new Error(
        `Blocked: '${hostname}' resolves to ${address}, a private/loopback/link-local address.`,
      );
    }
  }
}

// --- extraction ----------------------------------------------------------------

// Readability's types want lib.dom's Document; this codebase compiles without
// the DOM lib (linkedom provides the runtime DOM), so bind a structural
// constructor type instead of round-tripping through lib.dom.
const ReadabilityCtor = Readability as unknown as new (doc: unknown) => {
  parse(): { title?: string | null; content?: string | null } | null;
};

/**
 * Extract the readable article from an HTML string and convert it to
 * markdown: linkedom parses, Readability isolates the article (falling back
 * to the whole body when it finds none), turndown converts. Exported so the
 * extraction is testable on fixture HTML without any network.
 */
export function extractReadableMarkdown(
  html: string,
  url: string,
): { title?: string; markdown: string } {
  const { document } = parseHTML(html);
  const article = new ReadabilityCtor(document).parse();
  const turndown = new TurndownService({ headingStyle: "atx", codeBlockStyle: "fenced" });
  const source =
    article?.content ?? (document.body as { innerHTML?: string } | null)?.innerHTML ?? html;
  const markdown = turndown.turndown(source).trim();
  const docTitle = (document as { title?: string }).title;
  return {
    title: article?.title ?? (docTitle || undefined),
    markdown: markdown || `(no readable content at ${url})`,
  };
}

function truncate(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n\n[Content truncated at ${cap.toLocaleString()} characters.]`;
}

// --- the tool -------------------------------------------------------------------

/**
 * Build the `web_fetch` HemiTool. Always available — needs no provider or key.
 */
export function createWebFetchTool(opts: WebFetchOptions = {}): HemiTool<{ url: string }> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const lookup = opts.lookup ?? defaultLookup;
  const maxContentChars = opts.maxContentChars ?? DEFAULT_MAX_CONTENT_CHARS;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    name: "web_fetch",
    description:
      "Fetch a public web page and get its readable content back as markdown (article extraction, boilerplate stripped). Use it to read documentation, articles, or a web_search result in full. Only public http(s) URLs — private/internal addresses are blocked.",
    inputSchema: z.object({
      url: z.string().min(1).describe("The absolute http(s) URL to fetch."),
    }),
    readOnly: true,
    async execute({ url: rawUrl }, ctx) {
      let url: URL;
      try {
        url = new URL(rawUrl);
      } catch {
        return { content: `Invalid URL: ${rawUrl}`, isError: true };
      }

      // Follow redirects manually so EVERY hop passes the SSRF guard.
      let response: Response | undefined;
      for (let hop = 0; hop <= maxRedirects; hop++) {
        await assertPublicHttpUrl(url, lookup);
        const signal = ctx.signal.aborted
          ? ctx.signal
          : AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]);
        const res = await fetchImpl(url.toString(), {
          redirect: "manual",
          signal,
          headers: {
            "user-agent": "hemiunu-web-fetch/1.0",
            accept: "text/html,text/*;q=0.9,*/*;q=0.5",
          },
        });
        const location = res.headers.get("location");
        if (res.status >= 300 && res.status < 400 && location) {
          url = new URL(location, url); // re-checked at the top of the next hop
          continue;
        }
        response = res;
        break;
      }
      if (!response) {
        return { content: `Too many redirects (more than ${maxRedirects}).`, isError: true };
      }
      if (!response.ok) {
        return { content: `Fetch failed: HTTP ${response.status} for ${url}`, isError: true };
      }

      const contentType = response.headers.get("content-type") ?? "";
      const isHtml = /text\/html|application\/xhtml/i.test(contentType);
      const isText =
        isHtml ||
        /^text\/|application\/(json|xml|.*\+json|.*\+xml)|^$/i.test(
          contentType.split(";")[0].trim(),
        );
      if (!isText) {
        return {
          content: `Unsupported content type '${contentType}' — web_fetch only reads HTML and text.`,
          isError: true,
        };
      }

      const body = (await response.text()).slice(0, MAX_BODY_CHARS);
      if (!isHtml) {
        return { content: truncate(body.trim(), maxContentChars) };
      }
      const { title, markdown } = extractReadableMarkdown(body, url.toString());
      const head = [title && `# ${title}`, `URL: ${url}`].filter(Boolean).join("\n");
      return { content: truncate(`${head}\n\n${markdown}`, maxContentChars) };
    },
  };
}
