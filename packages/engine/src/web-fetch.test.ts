import assert from "node:assert/strict";
import { test } from "node:test";
import type { ToolContext } from "./tool";
import { createWebFetchTool, extractReadableMarkdown, isPrivateAddress } from "./web-fetch";

function ctx(): ToolContext {
  return {
    signal: new AbortController().signal,
    conversationId: "test",
    emit: () => {},
    mode: () => "default",
    setMode: () => {},
  };
}

/** A fetch mock keyed by URL; records every request it served. */
function fetchMock(routes: Record<string, () => Response>) {
  const requested: string[] = [];
  const impl: typeof fetch = async (input) => {
    const url = String(input);
    requested.push(url);
    const route = routes[url];
    if (!route) throw new Error(`no mock route for ${url}`);
    return route();
  };
  return { impl, requested };
}

const publicLookup = async () => [{ address: "93.184.216.34" }];

// --- SSRF guard -----------------------------------------------------------------

test("isPrivateAddress: private/loopback/link-local ranges are blocked, public are not", () => {
  for (const ip of [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "::ffff:192.168.0.1",
    "not-an-ip",
  ]) {
    assert.equal(isPrivateAddress(ip), true, `${ip} should be private`);
  }
  for (const ip of [
    "93.184.216.34",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "2606:2800:220:1::1",
  ]) {
    assert.equal(isPrivateAddress(ip), false, `${ip} should be public`);
  }
});

test("web_fetch: blocks literal private IPs and private DNS resolutions", async () => {
  const tool = createWebFetchTool({
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
    lookup: async () => [{ address: "192.168.1.7" }],
  });

  await assert.rejects(
    () => tool.execute({ url: "http://127.0.0.1/admin" }, ctx()),
    /private\/loopback\/link-local/,
  );
  await assert.rejects(
    () => tool.execute({ url: "http://10.0.0.5/secret" }, ctx()),
    /private\/loopback\/link-local/,
  );
  await assert.rejects(
    () => tool.execute({ url: "http://169.254.169.254/latest/meta-data/" }, ctx()),
    /private/,
  );
  // Public-looking hostname that RESOLVES into a private range → blocked too.
  await assert.rejects(
    () => tool.execute({ url: "https://internal.example.com/" }, ctx()),
    /resolves to 192\.168\.1\.7/,
  );
});

test("web_fetch: blocks non-http(s) schemes", async () => {
  const tool = createWebFetchTool({
    fetchImpl: async () => {
      throw new Error("must not fetch");
    },
    lookup: publicLookup,
  });
  await assert.rejects(
    () => tool.execute({ url: "ftp://example.com/file" }, ctx()),
    /only http\(s\)/,
  );
  await assert.rejects(() => tool.execute({ url: "file:///etc/passwd" }, ctx()), /only http\(s\)/);
});

test("web_fetch: blocks redirects into private ranges (every hop is re-checked)", async () => {
  const { impl, requested } = fetchMock({
    "https://example.com/": () =>
      new Response(null, { status: 302, headers: { location: "http://169.254.169.254/meta" } }),
  });
  const tool = createWebFetchTool({ fetchImpl: impl, lookup: publicLookup });
  await assert.rejects(() => tool.execute({ url: "https://example.com/" }, ctx()), /private/);
  assert.deepEqual(requested, ["https://example.com/"], "the private hop was never fetched");
});

test("web_fetch: follows public redirects and blocks redirects to bad schemes", async () => {
  const { impl } = fetchMock({
    "https://example.com/a": () => new Response(null, { status: 301, headers: { location: "/b" } }),
    "https://example.com/b": () =>
      new Response("plain text body", {
        status: 200,
        headers: { "content-type": "text/plain" },
      }),
  });
  const tool = createWebFetchTool({ fetchImpl: impl, lookup: publicLookup });
  const out = await tool.execute({ url: "https://example.com/a" }, ctx());
  assert.equal(out.isError, undefined);
  assert.equal(out.content, "plain text body");

  const bad = fetchMock({
    "https://example.com/a": () =>
      new Response(null, { status: 302, headers: { location: "ftp://example.com/x" } }),
  });
  const tool2 = createWebFetchTool({ fetchImpl: bad.impl, lookup: publicLookup });
  await assert.rejects(
    () => tool2.execute({ url: "https://example.com/a" }, ctx()),
    /only http\(s\)/,
  );
});

// --- extraction -----------------------------------------------------------------

const FIXTURE_HTML = `<!doctype html>
<html><head><title>Understanding Pyramids — Hemiunu Weekly</title></head>
<body>
  <nav><ul><li><a href="/">Home</a></li><li><a href="/about">About</a></li></ul></nav>
  <aside class="ads">Subscribe now! Best deals on papyrus!</aside>
  <article>
    <h1>Understanding Pyramids</h1>
    <p>${"Hemiunu, vizier to Khufu, is believed to be the architect of the Great Pyramid of Giza. ".repeat(12)}</p>
    <h2>Construction techniques</h2>
    <p>${"The logistics of moving millions of limestone blocks remain a subject of active research and debate among Egyptologists. ".repeat(12)}</p>
  </article>
  <footer>Copyright 2026 — nav footer boilerplate</footer>
</body></html>`;

test("extractReadableMarkdown: pulls the article out of fixture HTML as markdown", () => {
  const { title, markdown } = extractReadableMarkdown(FIXTURE_HTML, "https://example.com/pyramids");
  assert.match(title ?? "", /Understanding Pyramids/);
  assert.match(markdown, /Hemiunu, vizier to Khufu/);
  assert.match(markdown, /## Construction techniques/, "headings survive as markdown");
  assert.ok(!markdown.includes("Subscribe now!"), "boilerplate/ads are stripped");
  assert.ok(!markdown.includes("nav footer boilerplate"), "footer is stripped");
});

test("web_fetch: fetches HTML end-to-end (mocked) and returns capped markdown", async () => {
  const { impl } = fetchMock({
    "https://example.com/pyramids": () =>
      new Response(FIXTURE_HTML, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
  });
  const tool = createWebFetchTool({ fetchImpl: impl, lookup: publicLookup, maxContentChars: 500 });
  const out = await tool.execute({ url: "https://example.com/pyramids" }, ctx());
  assert.equal(out.isError, undefined);
  assert.match(out.content, /^# Understanding Pyramids/);
  assert.match(out.content, /URL: https:\/\/example\.com\/pyramids/);
  assert.match(out.content, /\[Content truncated at 500 characters\.\]$/);
  assert.ok(out.content.length < 700, "output is capped");
});

test("web_fetch: rejects unsupported content types and reports HTTP errors", async () => {
  const { impl } = fetchMock({
    "https://example.com/img.png": () =>
      new Response("binary", { status: 200, headers: { "content-type": "image/png" } }),
    "https://example.com/missing": () => new Response("nope", { status: 404 }),
  });
  const tool = createWebFetchTool({ fetchImpl: impl, lookup: publicLookup });

  const img = await tool.execute({ url: "https://example.com/img.png" }, ctx());
  assert.equal(img.isError, true);
  assert.match(img.content, /Unsupported content type/);

  const missing = await tool.execute({ url: "https://example.com/missing" }, ctx());
  assert.equal(missing.isError, true);
  assert.match(missing.content, /HTTP 404/);
});
