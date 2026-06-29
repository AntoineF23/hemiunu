import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { discoveryLine, loadAtlas, MONUMENTS, recordDiscovery, TIER_ORDER, TIERS } from "./atlas";

// Each test runs against a throwaway config dir so atlas.json never touches the
// real one (or another test's state).
let dir: string;
let prev: string | undefined;
beforeEach(() => {
  prev = process.env.HEMIUNU_CONFIG_DIR;
  dir = mkdtempSync(join(tmpdir(), "hemiunu-atlas-"));
  process.env.HEMIUNU_CONFIG_DIR = dir;
});
afterEach(() => {
  if (prev === undefined) delete process.env.HEMIUNU_CONFIG_DIR;
  else process.env.HEMIUNU_CONFIG_DIR = prev;
  rmSync(dir, { recursive: true, force: true });
});

test("catalog: ids are unique and coordinates are valid", () => {
  const ids = new Set(MONUMENTS.map((m) => m.id));
  assert.equal(ids.size, MONUMENTS.length, "duplicate monument id");
  for (const m of MONUMENTS) {
    assert.ok(m.lat >= -90 && m.lat <= 90, `${m.id} lat out of range`);
    assert.ok(m.lng >= -180 && m.lng <= 180, `${m.id} lng out of range`);
    assert.ok(TIER_ORDER.includes(m.tier), `${m.id} unknown tier`);
  }
});

test("tier rates sum to 1 and every tier has monuments", () => {
  const sum = TIER_ORDER.reduce((s, t) => s + TIERS[t].rate, 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `rates sum to ${sum}`);
  for (const t of TIER_ORDER) {
    assert.ok(
      MONUMENTS.some((m) => m.tier === t),
      `tier ${t} has no monuments`,
    );
  }
});

test("recordDiscovery: persists a new discovery and reports progress", () => {
  // rng=0 → first tier (common), first monument in pool.
  const r = recordDiscovery("acme/proto", () => 0);
  assert.equal(r.isNew, true);
  assert.equal(r.collected, 1);
  assert.equal(r.total, MONUMENTS.length);
  const after = loadAtlas();
  assert.equal(after.discoveries.length, 1);
  assert.equal(after.discoveries[0].repo, "acme/proto");
  assert.equal(after.discoveries[0].sightings, 1);
});

test("recordDiscovery: never draws a duplicate until the catalog is exhausted", () => {
  // Cycle rng so successive draws land on different monuments/tiers.
  let i = 0;
  const rng = () => ((i++ % 97) / 97 + 0.013) % 1;
  for (let n = 0; n < MONUMENTS.length; n++) recordDiscovery(null, rng);
  const owned = loadAtlas().discoveries;
  assert.equal(owned.length, MONUMENTS.length, "should have collected the whole catalog uniquely");
  assert.equal(new Set(owned.map((d) => d.id)).size, MONUMENTS.length);

  // One more draw can only be a repeat sighting now.
  const extra = recordDiscovery(null, rng);
  assert.equal(extra.isNew, false);
  assert.equal(loadAtlas().discoveries.length, MONUMENTS.length, "no new entry after exhaustion");
});

test("discoveryLine: wonders get the loud banner, repeats are acknowledged", () => {
  const wonder = MONUMENTS.find((m) => m.tier === "wonder");
  assert.ok(wonder);
  const line = discoveryLine({
    monument: wonder,
    isNew: true,
    tier: "wonder",
    collected: 1,
    total: MONUMENTS.length,
  });
  assert.match(line, /WONDER OF THE WORLD/);
});
