import assert from "node:assert/strict";
import { test } from "node:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { capOutput, verifyPrototype } from "./verify";

const here = dirname(fileURLToPath(import.meta.url));

test("verifyPrototype: a static HTML wireframe has nothing to compile", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hemiunu-verify-"));
  try {
    writeFileSync(join(dir, "index.html"), "<!doctype html><h1>wireframe</h1>");
    const r = await verifyPrototype(dir);
    assert.equal(r.ok, true);
    assert.match(r.note, /static/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyPrototype: uninstalled dependencies skip gracefully, never fail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "hemiunu-verify-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    const r = await verifyPrototype(dir);
    assert.equal(r.ok, true);
    assert.match(r.note, /not installed/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyPrototype: tsc catches a type error the dev server would serve as 200", async (t) => {
  // Borrow the repo's own typescript package: link it into the fixture the way
  // a real install lays it out (node_modules/typescript + a .bin/tsc pointing
  // at its bin script), so the check runs exactly as it would in a prototype.
  const repoTs = realpathSync(resolve(here, "..", "..", "..", "node_modules", "typescript"));
  if (!existsSync(join(repoTs, "bin", "tsc"))) {
    t.skip("typescript not installed in this checkout");
    return;
  }
  const dir = mkdtempSync(join(tmpdir(), "hemiunu-verify-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, skipLibCheck: true },
        include: ["src"],
      }),
    );
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src", "broken.ts"), "const n: number = 'not a number';\n");
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    symlinkSync(repoTs, join(dir, "node_modules", "typescript"));
    symlinkSync(
      join(dir, "node_modules", "typescript", "bin", "tsc"),
      join(dir, "node_modules", ".bin", "tsc"),
    );

    const broken = await verifyPrototype(dir);
    assert.equal(broken.ok, false, "a type error must fail verification");
    assert.match(broken.output ?? "", /broken\.ts/);

    writeFileSync(join(dir, "src", "broken.ts"), "const n: number = 1;\nvoid n;\n");
    const fixed = await verifyPrototype(dir);
    assert.equal(fixed.ok, true, `repaired project should pass: ${fixed.output ?? fixed.note}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capOutput: long compiler output is truncated with a hint", () => {
  const out = capOutput("x".repeat(10_000), 100);
  assert.ok(out.length < 200);
  assert.match(out, /truncated/);
  assert.equal(capOutput("  short  "), "short");
});
