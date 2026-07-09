import assert from "node:assert/strict";
import { test } from "node:test";
import { Hono } from "hono";
import { MAX_BODY_BYTES, bodyLimit, isAllowedOrigin, originGuard } from "./origin-guard";

test("isAllowedOrigin: a missing Origin is allowed (same-origin / navigation)", () => {
  assert.equal(isAllowedOrigin(undefined), true);
  assert.equal(isAllowedOrigin(null), true);
  assert.equal(isAllowedOrigin(""), true);
});

test("isAllowedOrigin: loopback origins pass, any other host fails", () => {
  assert.equal(isAllowedOrigin("http://127.0.0.1:4317"), true);
  assert.equal(isAllowedOrigin("http://localhost:5173"), true);
  assert.equal(isAllowedOrigin("https://evil.example.com"), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1.evil.com"), false);
});

test("isAllowedOrigin: a malformed Origin is rejected", () => {
  assert.equal(isAllowedOrigin("not a url"), false);
});

// End-to-end through Hono, mirroring how index.ts mounts the guard on /api/*.
function guardedApp() {
  const app = new Hono();
  app.use("/api/*", originGuard);
  app.get("/api/ping", (c) => c.json({ ok: true }));
  return app;
}

test("originGuard: allows a request with no Origin header", async () => {
  const res = await guardedApp().request("/api/ping");
  assert.equal(res.status, 200);
});

test("originGuard: allows a loopback Origin", async () => {
  const res = await guardedApp().request("/api/ping", {
    headers: { origin: "http://localhost:5173" },
  });
  assert.equal(res.status, 200);
});

test("originGuard: 403s a cross-site Origin", async () => {
  const res = await guardedApp().request("/api/ping", {
    headers: { origin: "https://evil.example.com" },
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "forbidden origin" });
});

test("originGuard: 403s a malformed Origin as 'bad origin'", async () => {
  const res = await guardedApp().request("/api/ping", {
    headers: { origin: "http://[::bad" },
  });
  assert.equal(res.status, 403);
  assert.deepEqual(await res.json(), { error: "bad origin" });
});

function bodyLimitedApp() {
  const app = new Hono();
  app.use("/api/*", bodyLimit);
  app.post("/api/echo", (c) => c.json({ ok: true }));
  return app;
}

test("bodyLimit: allows a body within the cap", async () => {
  const res = await bodyLimitedApp().request("/api/echo", {
    method: "POST",
    headers: { "content-length": String(MAX_BODY_BYTES - 1) },
    body: "x",
  });
  assert.equal(res.status, 200);
});

test("bodyLimit: 413s a body over the cap by Content-Length", async () => {
  const res = await bodyLimitedApp().request("/api/echo", {
    method: "POST",
    headers: { "content-length": String(MAX_BODY_BYTES + 1) },
    body: "x",
  });
  assert.equal(res.status, 413);
  assert.deepEqual(await res.json(), { error: "payload too large" });
});
