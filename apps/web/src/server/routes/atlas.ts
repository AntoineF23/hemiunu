// The Atlas — the gamified world map. Returns the user's global collection of
// discovered monuments (earned by publishing prototypes to main) plus the tier
// metadata the map legend needs. Read-only: discoveries are minted by the
// `commit_prototype to=main` publish path in agent-core, not here.
import { Hono } from "hono";
import { loadAtlas, MONUMENTS, TIER_ORDER, TIERS } from "@hemiunu/agent-core";

export const atlasRoute = new Hono();

atlasRoute.get("/api/atlas", (c) => {
  const { discoveries } = loadAtlas();
  // Per-tier catalog totals so the UI can show collection progress (e.g. 2/8
  // Wonders) without shipping the whole catalog to the client.
  const totals = Object.fromEntries(
    TIER_ORDER.map((t) => [t, MONUMENTS.filter((m) => m.tier === t).length]),
  );
  return c.json({
    discoveries,
    tiers: TIERS,
    tierOrder: TIER_ORDER,
    totals,
    total: MONUMENTS.length,
  });
});
