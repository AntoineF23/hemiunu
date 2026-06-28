import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "./config";

/**
 * The Atlas — a gamification layer. Every time the user *publishes* a prototype
 * to main (the explicit `commit_prototype to=main` action), they discover a
 * random famous building of the world, drawn by rarity tier. Discoveries
 * accumulate into a single global collection (one trophy wall per user) pinned
 * on an interactive world map in the web app; the CLI just announces each find.
 *
 * This module owns three things: the CATALOG of monuments, the weighted DRAW,
 * and the JSON-file PERSISTENCE (~/.hemiunu/atlas.json). It deliberately keeps
 * its own tiny store rather than touching the SQLite ConversationStore, so the
 * agent-core publish hook and the web route can both reach it without a DB
 * handle — the collection is global, so a single file is the natural home.
 */

export type Tier = "common" | "rare" | "epic" | "legendary" | "wonder";

export interface TierMeta {
  /** Draw weight — the probability mass for this tier (the five sum to 1). */
  rate: number;
  label: string;
  /** A swatch colour for the map pin / legend (hex, matches the desert theme). */
  color: string;
  emoji: string;
}

/** Tier metadata, ordered rarest-last. Rates sum to 1.0. */
export const TIERS: Record<Tier, TierMeta> = {
  common: { rate: 0.5, label: "Common", color: "#9a8c78", emoji: "🟫" },
  rare: { rate: 0.28, label: "Rare", color: "#4a90c2", emoji: "🟦" },
  epic: { rate: 0.14, label: "Epic", color: "#9b59b6", emoji: "🟪" },
  legendary: { rate: 0.07, label: "Legendary", color: "#e0a020", emoji: "🟨" },
  wonder: { rate: 0.01, label: "Wonder of the World", color: "#e8533f", emoji: "🌟" },
};

/** Tiers from most to least common — the order draws roll through. */
export const TIER_ORDER: Tier[] = ["common", "rare", "epic", "legendary", "wonder"];

export interface Monument {
  /** Stable kebab-case id (the collection key). */
  id: string;
  name: string;
  city: string;
  country: string;
  /** Latitude in decimal degrees (north positive). */
  lat: number;
  /** Longitude in decimal degrees (east positive). */
  lng: number;
  tier: Tier;
}

/**
 * The catalog — ~70 famous buildings spread across the globe and the five
 * tiers. Coordinates are approximate decimal degrees, good enough to pin on an
 * equirectangular world map. The eight Wonders are the four-corners of the
 * ancient survivors + the New7Wonders set.
 */
export const MONUMENTS: Monument[] = [
  // 🌟 Wonders — the rarest draw.
  { id: "great-pyramid-giza", name: "Great Pyramid of Giza", city: "Giza", country: "Egypt", lat: 29.9792, lng: 31.1342, tier: "wonder" },
  { id: "colosseum", name: "Colosseum", city: "Rome", country: "Italy", lat: 41.8902, lng: 12.4922, tier: "wonder" },
  { id: "great-wall", name: "Great Wall of China", city: "Beijing", country: "China", lat: 40.4319, lng: 116.5704, tier: "wonder" },
  { id: "petra", name: "Petra", city: "Ma'an", country: "Jordan", lat: 30.3285, lng: 35.4444, tier: "wonder" },
  { id: "machu-picchu", name: "Machu Picchu", city: "Cusco", country: "Peru", lat: -13.1631, lng: -72.545, tier: "wonder" },
  { id: "chichen-itza", name: "Chichén Itzá", city: "Yucatán", country: "Mexico", lat: 20.6843, lng: -88.5678, tier: "wonder" },
  { id: "christ-the-redeemer", name: "Christ the Redeemer", city: "Rio de Janeiro", country: "Brazil", lat: -22.9519, lng: -43.2105, tier: "wonder" },
  { id: "taj-mahal", name: "Taj Mahal", city: "Agra", country: "India", lat: 27.1751, lng: 78.0421, tier: "wonder" },

  // 🟨 Legendary — the absolute icons.
  { id: "eiffel-tower", name: "Eiffel Tower", city: "Paris", country: "France", lat: 48.8584, lng: 2.2945, tier: "legendary" },
  { id: "burj-khalifa", name: "Burj Khalifa", city: "Dubai", country: "UAE", lat: 25.1972, lng: 55.2744, tier: "legendary" },
  { id: "sagrada-familia", name: "Sagrada Família", city: "Barcelona", country: "Spain", lat: 41.4036, lng: 2.1744, tier: "legendary" },
  { id: "statue-of-liberty", name: "Statue of Liberty", city: "New York", country: "USA", lat: 40.6892, lng: -74.0445, tier: "legendary" },
  { id: "sydney-opera-house", name: "Sydney Opera House", city: "Sydney", country: "Australia", lat: -33.8568, lng: 151.2153, tier: "legendary" },
  { id: "forbidden-city", name: "Forbidden City", city: "Beijing", country: "China", lat: 39.9163, lng: 116.3972, tier: "legendary" },
  { id: "big-ben", name: "Big Ben", city: "London", country: "UK", lat: 51.5007, lng: -0.1246, tier: "legendary" },
  { id: "parthenon", name: "The Parthenon", city: "Athens", country: "Greece", lat: 37.9715, lng: 23.7257, tier: "legendary" },
  { id: "angkor-wat", name: "Angkor Wat", city: "Siem Reap", country: "Cambodia", lat: 13.4125, lng: 103.867, tier: "legendary" },
  { id: "st-basils", name: "St. Basil's Cathedral", city: "Moscow", country: "Russia", lat: 55.7525, lng: 37.6231, tier: "legendary" },

  // 🟪 Epic — globally famous.
  { id: "leaning-tower-pisa", name: "Leaning Tower of Pisa", city: "Pisa", country: "Italy", lat: 43.723, lng: 10.3966, tier: "epic" },
  { id: "golden-gate", name: "Golden Gate Bridge", city: "San Francisco", country: "USA", lat: 37.8199, lng: -122.4783, tier: "epic" },
  { id: "empire-state", name: "Empire State Building", city: "New York", country: "USA", lat: 40.7484, lng: -73.9857, tier: "epic" },
  { id: "brandenburg-gate", name: "Brandenburg Gate", city: "Berlin", country: "Germany", lat: 52.5163, lng: 13.3777, tier: "epic" },
  { id: "neuschwanstein", name: "Neuschwanstein Castle", city: "Schwangau", country: "Germany", lat: 47.5576, lng: 10.7498, tier: "epic" },
  { id: "tower-bridge", name: "Tower Bridge", city: "London", country: "UK", lat: 51.5055, lng: -0.0754, tier: "epic" },
  { id: "burj-al-arab", name: "Burj Al Arab", city: "Dubai", country: "UAE", lat: 25.1412, lng: 55.1853, tier: "epic" },
  { id: "petronas-towers", name: "Petronas Towers", city: "Kuala Lumpur", country: "Malaysia", lat: 3.1578, lng: 101.7117, tier: "epic" },
  { id: "cn-tower", name: "CN Tower", city: "Toronto", country: "Canada", lat: 43.6426, lng: -79.3871, tier: "epic" },
  { id: "hagia-sophia", name: "Hagia Sophia", city: "Istanbul", country: "Turkey", lat: 41.0086, lng: 28.9802, tier: "epic" },
  { id: "notre-dame", name: "Notre-Dame de Paris", city: "Paris", country: "France", lat: 48.853, lng: 2.3499, tier: "epic" },
  { id: "tokyo-tower", name: "Tokyo Tower", city: "Tokyo", country: "Japan", lat: 35.6586, lng: 139.7454, tier: "epic" },
  { id: "marina-bay-sands", name: "Marina Bay Sands", city: "Singapore", country: "Singapore", lat: 1.2834, lng: 103.8607, tier: "epic" },
  { id: "alhambra", name: "The Alhambra", city: "Granada", country: "Spain", lat: 37.1761, lng: -3.5881, tier: "epic" },
  { id: "potala-palace", name: "Potala Palace", city: "Lhasa", country: "China", lat: 29.6557, lng: 91.1175, tier: "epic" },

  // 🟦 Rare — nationally iconic.
  { id: "arc-de-triomphe", name: "Arc de Triomphe", city: "Paris", country: "France", lat: 48.8738, lng: 2.295, tier: "rare" },
  { id: "sacre-coeur", name: "Sacré-Cœur", city: "Paris", country: "France", lat: 48.8867, lng: 2.3431, tier: "rare" },
  { id: "cologne-cathedral", name: "Cologne Cathedral", city: "Cologne", country: "Germany", lat: 50.9413, lng: 6.9583, tier: "rare" },
  { id: "fernsehturm", name: "Berlin TV Tower", city: "Berlin", country: "Germany", lat: 52.5208, lng: 13.4094, tier: "rare" },
  { id: "buckingham-palace", name: "Buckingham Palace", city: "London", country: "UK", lat: 51.5014, lng: -0.1419, tier: "rare" },
  { id: "edinburgh-castle", name: "Edinburgh Castle", city: "Edinburgh", country: "UK", lat: 55.9486, lng: -3.1999, tier: "rare" },
  { id: "charles-bridge", name: "Charles Bridge", city: "Prague", country: "Czechia", lat: 50.0865, lng: 14.4114, tier: "rare" },
  { id: "schonbrunn", name: "Schönbrunn Palace", city: "Vienna", country: "Austria", lat: 48.1858, lng: 16.3122, tier: "rare" },
  { id: "atomium", name: "Atomium", city: "Brussels", country: "Belgium", lat: 50.895, lng: 4.3415, tier: "rare" },
  { id: "willis-tower", name: "Willis Tower", city: "Chicago", country: "USA", lat: 41.8789, lng: -87.6359, tier: "rare" },
  { id: "one-wtc", name: "One World Trade Center", city: "New York", country: "USA", lat: 40.7127, lng: -74.0134, tier: "rare" },
  { id: "himeji-castle", name: "Himeji Castle", city: "Himeji", country: "Japan", lat: 34.8394, lng: 134.6939, tier: "rare" },
  { id: "shanghai-tower", name: "Shanghai Tower", city: "Shanghai", country: "China", lat: 31.2336, lng: 121.5055, tier: "rare" },
  { id: "st-peters", name: "St. Peter's Basilica", city: "Vatican City", country: "Vatican", lat: 41.9022, lng: 12.4539, tier: "rare" },
  { id: "duomo-milano", name: "Duomo di Milano", city: "Milan", country: "Italy", lat: 45.4642, lng: 9.19, tier: "rare" },
  { id: "gateway-arch", name: "Gateway Arch", city: "St. Louis", country: "USA", lat: 38.6247, lng: -90.1848, tier: "rare" },

  // 🟫 Common — widely-known landmarks.
  { id: "london-eye", name: "London Eye", city: "London", country: "UK", lat: 51.5033, lng: -0.1196, tier: "common" },
  { id: "chrysler-building", name: "Chrysler Building", city: "New York", country: "USA", lat: 40.7516, lng: -73.9755, tier: "common" },
  { id: "flatiron", name: "Flatiron Building", city: "New York", country: "USA", lat: 40.7411, lng: -73.9897, tier: "common" },
  { id: "space-needle", name: "Space Needle", city: "Seattle", country: "USA", lat: 47.6205, lng: -122.3493, tier: "common" },
  { id: "reichstag", name: "Reichstag", city: "Berlin", country: "Germany", lat: 52.5186, lng: 13.3762, tier: "common" },
  { id: "sydney-harbour-bridge", name: "Sydney Harbour Bridge", city: "Sydney", country: "Australia", lat: -33.8523, lng: 151.2108, tier: "common" },
  { id: "sky-tower-auckland", name: "Sky Tower", city: "Auckland", country: "New Zealand", lat: -36.8485, lng: 174.7623, tier: "common" },
  { id: "oriental-pearl", name: "Oriental Pearl Tower", city: "Shanghai", country: "China", lat: 31.2397, lng: 121.4998, tier: "common" },
  { id: "lotus-temple", name: "Lotus Temple", city: "New Delhi", country: "India", lat: 28.5535, lng: 77.2588, tier: "common" },
  { id: "india-gate", name: "India Gate", city: "New Delhi", country: "India", lat: 28.6129, lng: 77.2295, tier: "common" },
  { id: "gateway-of-india", name: "Gateway of India", city: "Mumbai", country: "India", lat: 18.922, lng: 72.8347, tier: "common" },
  { id: "wat-arun", name: "Wat Arun", city: "Bangkok", country: "Thailand", lat: 13.7437, lng: 100.4889, tier: "common" },
  { id: "sensoji", name: "Sensō-ji", city: "Tokyo", country: "Japan", lat: 35.7148, lng: 139.7967, tier: "common" },
  { id: "bran-castle", name: "Bran Castle", city: "Brașov", country: "Romania", lat: 45.5149, lng: 25.3672, tier: "common" },
  { id: "belem-tower", name: "Belém Tower", city: "Lisbon", country: "Portugal", lat: 38.6916, lng: -9.216, tier: "common" },
  { id: "casa-mila", name: "Casa Milà", city: "Barcelona", country: "Spain", lat: 41.3953, lng: 2.1619, tier: "common" },
  { id: "trevi-fountain", name: "Trevi Fountain", city: "Rome", country: "Italy", lat: 41.9009, lng: 12.4833, tier: "common" },
  { id: "pantheon-rome", name: "Pantheon", city: "Rome", country: "Italy", lat: 41.8986, lng: 12.4769, tier: "common" },
  { id: "stonehenge", name: "Stonehenge", city: "Wiltshire", country: "UK", lat: 51.1789, lng: -1.8262, tier: "common" },
  { id: "us-capitol", name: "United States Capitol", city: "Washington, D.C.", country: "USA", lat: 38.8899, lng: -77.0091, tier: "common" },
  { id: "white-house", name: "The White House", city: "Washington, D.C.", country: "USA", lat: 38.8977, lng: -77.0365, tier: "common" },
  { id: "grand-palace-bangkok", name: "Grand Palace", city: "Bangkok", country: "Thailand", lat: 13.75, lng: 100.4914, tier: "common" },
];

/** A monument the user has discovered, with when/where it was found. */
export interface Discovery {
  id: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  tier: Tier;
  /** ISO timestamp of the FIRST sighting. */
  discoveredAt: string;
  /** The repo whose publish unlocked it (provenance / flavour). */
  repo: string | null;
  /** How many times it has been drawn (>1 once the catalog is exhausted). */
  sightings: number;
}

interface AtlasState {
  discoveries: Discovery[];
}

/** The collection file — a single global trophy wall per user. */
export function atlasPath(): string {
  return join(configDir(), "atlas.json");
}

export function loadAtlas(): AtlasState {
  const path = atlasPath();
  if (!existsSync(path)) return { discoveries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<AtlasState>;
    return { discoveries: Array.isArray(parsed.discoveries) ? parsed.discoveries : [] };
  } catch {
    // A corrupt file shouldn't crash a publish — start the collection over only
    // in memory; the next successful write repairs it.
    return { discoveries: [] };
  }
}

function saveAtlas(state: AtlasState): void {
  const path = atlasPath();
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

/** Roll a tier by weight. `rng` defaults to Math.random (overridable for tests). */
function rollTier(rng: () => number): Tier {
  let r = rng();
  for (const tier of TIER_ORDER) {
    r -= TIERS[tier].rate;
    if (r < 0) return tier;
  }
  return "common"; // floating-point guard
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

export interface DiscoveryResult {
  monument: Monument | Discovery;
  /** True when this is a brand-new monument; false = a repeat sighting. */
  isNew: boolean;
  tier: Tier;
  /** How many distinct monuments are now collected. */
  collected: number;
  /** Total monuments in the catalog. */
  total: number;
}

/**
 * Draw one monument for a publish and persist it. Rolls a tier by weight, then
 * picks a not-yet-owned monument from it; if that tier is exhausted it falls
 * back to any unowned monument (so a lucky-tier roll never wastes a discovery),
 * and once the whole catalog is collected it records a repeat sighting instead.
 */
export function recordDiscovery(repo: string | null, rng: () => number = Math.random): DiscoveryResult {
  const state = loadAtlas();
  const owned = new Map(state.discoveries.map((d) => [d.id, d] as const));
  const total = MONUMENTS.length;

  const tier = rollTier(rng);
  let pool = MONUMENTS.filter((m) => m.tier === tier && !owned.has(m.id));
  if (pool.length === 0) pool = MONUMENTS.filter((m) => !owned.has(m.id));

  // Catalog complete → a repeat sighting of an owned monument (weighted nowhere;
  // just a random keepsake). Bumps its sighting count.
  if (pool.length === 0) {
    const existing = pick(state.discoveries, rng);
    existing.sightings += 1;
    saveAtlas(state);
    return { monument: existing, isNew: false, tier: existing.tier, collected: owned.size, total };
  }

  const monument = pick(pool, rng);
  const discovery: Discovery = {
    id: monument.id,
    name: monument.name,
    city: monument.city,
    country: monument.country,
    lat: monument.lat,
    lng: monument.lng,
    tier: monument.tier,
    discoveredAt: new Date().toISOString(),
    repo,
    sightings: 1,
  };
  state.discoveries.push(discovery);
  saveAtlas(state);
  return { monument, isNew: true, tier: monument.tier, collected: owned.size + 1, total };
}

/**
 * The one-line announcement shown on BOTH surfaces (CLI note + web tool result).
 * Wonders get a louder banner; repeats are acknowledged rather than celebrated.
 */
export function discoveryLine(r: DiscoveryResult): string {
  const t = TIERS[r.tier];
  const m = r.monument;
  const place = `${m.city}, ${m.country}`;
  if (!r.isNew) {
    const sightings = "sightings" in m ? m.sightings : 1;
    return `🗺️  The atlas is complete — you sighted ${m.name} again (${place}), now ×${sightings}.`;
  }
  const progress = `[${r.collected}/${r.total} collected]`;
  if (r.tier === "wonder") {
    return `🌟 WONDER OF THE WORLD! You discovered ${m.name} — ${place}. A once-in-a-blue-moon find. ${progress}`;
  }
  return `${t.emoji} Discovery! You unlocked ${m.name} (${t.label}) — ${place}. ${progress}`;
}
