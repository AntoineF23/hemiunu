import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMcpOAuth, parseWwwAuthenticate, pkceChallenge } from "./mcp-oauth";

test("pkceChallenge matches the RFC 7636 test vector", () => {
  assert.equal(
    pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  );
});

test("parseWwwAuthenticate extracts the OAuth hints (Figma's real header)", () => {
  const h =
    'Bearer resource_metadata="https://mcp.figma.com/.well-known/oauth-protected-resource",scope="mcp:connect",authorization_uri="https://api.figma.com/.well-known/oauth-authorization-server"';
  const r = parseWwwAuthenticate(h);
  assert.equal(r.resourceMetadata, "https://mcp.figma.com/.well-known/oauth-protected-resource");
  assert.equal(r.scope, "mcp:connect");
  assert.equal(r.authorizationUri, "https://api.figma.com/.well-known/oauth-authorization-server");
});

test("applyMcpOAuth injects a Bearer header for stored servers only", async () => {
  const prev = process.env.HEMIUNU_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "hemiunu-mcpoauth-"));
  process.env.HEMIUNU_CONFIG_DIR = dir;
  try {
    writeFileSync(
      join(dir, "mcp-oauth.json"),
      JSON.stringify({
        records: [
          {
            server: "Figma",
            serverUrl: "https://mcp.figma.com/mcp",
            authorizationEndpoint: "https://x/auth",
            tokenEndpoint: "https://x/token",
            clientId: "c",
            accessToken: "tok123",
          },
        ],
      }),
    );
    const out = await applyMcpOAuth({
      Figma: { type: "http", url: "https://mcp.figma.com/mcp" },
      Other: { type: "http", url: "https://other.example/mcp" },
    });
    const figma = out.Figma as { headers?: Record<string, string> };
    assert.equal(figma.headers?.Authorization, "Bearer tok123");
    const other = out.Other as { headers?: Record<string, string> };
    assert.equal(other.headers, undefined); // untouched — no stored token
  } finally {
    if (prev === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
    else process.env.HEMIUNU_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("applyMcpOAuth is a no-op when there are no stored tokens", async () => {
  const prev = process.env.HEMIUNU_CONFIG_DIR;
  const dir = mkdtempSync(join(tmpdir(), "hemiunu-mcpoauth-"));
  process.env.HEMIUNU_CONFIG_DIR = dir;
  try {
    const servers = { Foo: { type: "http", url: "https://foo/mcp" } };
    const out = await applyMcpOAuth(servers);
    assert.deepEqual(out, servers);
  } finally {
    if (prev === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
    else process.env.HEMIUNU_CONFIG_DIR = prev;
    rmSync(dir, { recursive: true, force: true });
  }
});
