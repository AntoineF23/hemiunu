import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Loader2, MapPin } from "lucide-react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import * as THREE from "three";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getJSON } from "@/lib/api";
import worldData from "@/assets/world.geo.json";

// The land of the dotted morph-globe: the same world GeoJSON the flat map used,
// rendered as react-globe.gl's hex-dot polygons (the "GlobeMorph" tech-globe
// look) — no satellite texture, so it stays offline and on-theme.
const LAND = (worldData as { features: object[] }).features;

// The monument's Wikipedia article. Derived from the name rather than stored:
// these are world-famous landmarks, and Wikipedia's redirects resolve the
// common name to the right article (e.g. "Big Ben", "Chichén Itzá").
function wikiUrl(name: string): string {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(name.replace(/\s+/g, "_"))}`;
}

// --- shared shape with the server (/api/atlas) ------------------------------
type Tier = "common" | "rare" | "epic" | "legendary" | "wonder";
interface TierMeta {
  rate: number;
  label: string;
  color: string;
  emoji: string;
}
interface Discovery {
  id: string;
  name: string;
  city: string;
  country: string;
  lat: number;
  lng: number;
  tier: Tier;
  discoveredAt: string;
  repo: string | null;
  sightings: number;
}
interface AtlasData {
  discoveries: Discovery[];
  tiers: Record<Tier, TierMeta>;
  tierOrder: Tier[];
  totals: Record<Tier, number>;
  total: number;
}

interface GlobePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When set, select + spin to this monument once the collection has loaded. */
  focusId?: string | null;
}

export function GlobePanel({ open, focusId }: GlobePanelProps) {
  const [data, setData] = useState<AtlasData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const globeRef = useRef<GlobeMethods | undefined>(undefined);
  const wrapRef = useRef<HTMLDivElement>(null);
  // The globe is a visual centrepiece, not the whole panel. Capped below the
  // column width so the monuments list below always has room — but the list
  // scrolls in its own area, so the globe can stay a comfortable size.
  const [size, setSize] = useState(320);

  // A matte dark-gray sphere under the dotted land — unlit so it reads the
  // same regardless of the scene lighting, and sits quietly on the dark theme.
  const globeMaterial = useMemo(() => new THREE.MeshBasicMaterial({ color: "#393E46" }), []);

  // Signature of the last-rendered collection, so background polls only re-set
  // state (and re-render the globe) when something actually changed.
  const sigRef = useRef<string>("");

  const load = useCallback(async ({ silent }: { silent?: boolean } = {}) => {
    if (!silent) setLoading(true);
    try {
      const next = await getJSON<AtlasData>("/api/atlas");
      const sig = next.discoveries.map((d) => `${d.id}:${d.sightings}`).join(",");
      if (sig !== sigRef.current) {
        sigRef.current = sig;
        setData(next);
      }
      setError(null);
    } catch (e) {
      // A failed background poll shouldn't blow away a good globe — only surface
      // errors on an explicit (non-silent) load.
      if (!silent) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  // Auto-refresh: load on open, then poll while open so a monument discovered
  // mid-session (publishing to main) appears without any manual refresh. Also
  // refetch the moment the tab/window regains focus.
  useEffect(() => {
    if (!open) return;
    void load();
    const id = window.setInterval(() => void load({ silent: true }), 4000);
    const onFocus = () => void load({ silent: true });
    window.addEventListener("focus", onFocus);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("focus", onFocus);
    };
  }, [open, load]);

  // Keep the globe square and sized to the panel column.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 0) setSize(Math.min(w, 320));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const configureControls = useCallback(() => {
    const c = globeRef.current?.controls() as
      | {
          autoRotate: boolean;
          autoRotateSpeed: number;
          enableZoom: boolean;
          minDistance: number;
          maxDistance: number;
        }
      | undefined;
    if (!c) return;
    c.autoRotate = true;
    c.autoRotateSpeed = 0.45;
    c.enableZoom = true;
    c.minDistance = 180;
    c.maxDistance = 600;
    // Pull the camera in a touch so the globe fills its rectangle rather than
    // floating small in the middle.
    globeRef.current?.pointOfView({ altitude: 1.9 });
  }, []);

  const discoveries = data?.discoveries ?? [];
  const tiers = data?.tiers;
  const tierOrder = data?.tierOrder ?? [];
  const selectedDisc = discoveries.find((d) => d.id === selected) ?? null;

  // The collection, rarest first (tierOrder runs common→wonder), then A–Z — so
  // the prize finds sit at the top and the list reads as monuments, not tiers.
  const sorted = useMemo(() => {
    if (!data) return [];
    const order = data.tierOrder;
    return [...data.discoveries].sort(
      (a, b) => order.indexOf(b.tier) - order.indexOf(a.tier) || a.name.localeCompare(b.name),
    );
  }, [data]);

  const focus = useCallback((d: Discovery) => {
    setSelected(d.id);
    // Fly to the monument and zoom in close (lower altitude = nearer the surface).
    globeRef.current?.pointOfView({ lat: d.lat, lng: d.lng, altitude: 0.9 }, 1000);
  }, []);

  // On open, fly the globe to the first monument in the list (the rarest find)
  // and select it, so the panel lands on something rather than a bare globe. A
  // short delay lets the globe finish mounting so the camera move actually lands.
  // Skipped when a deep link already targets a specific monument.
  useEffect(() => {
    if (!data || selected || focusId) return;
    const first = sorted[0];
    if (!first) return;
    const t = window.setTimeout(() => focus(first), 350);
    return () => window.clearTimeout(t);
  }, [data, selected, focusId, sorted, focus]);

  // Deep-link / earned-monument focus: once the collection has loaded, select
  // and fly to the requested monument (if the user owns it). A short delay lets
  // the globe finish mounting so the camera move actually lands.
  useEffect(() => {
    if (!focusId || !data) return;
    const d = data.discoveries.find((x) => x.id === focusId);
    if (!d) return;
    const t = window.setTimeout(() => focus(d), 300);
    return () => window.clearTimeout(t);
  }, [focusId, data, focus]);

  return (
    <>
      <SheetHeader>
        <SheetTitle className="flex items-center gap-2">
          <MapPin className="size-5 text-sun" /> Atlas
          {loading && <Loader2 className="ml-auto size-3.5 animate-spin text-ink-3" />}
        </SheetTitle>
        <SheetDescription>
          {discoveries.length} of {data?.total ?? "…"} monuments collected · earned by publishing
          prototypes to main
        </SheetDescription>
      </SheetHeader>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* The globe — no frame, so zooming in isn't clipped by a container box. */}
      <div ref={wrapRef} className="flex shrink-0 justify-center">
        <Globe
          ref={globeRef}
          width={size}
          height={size}
          backgroundColor="rgba(0,0,0,0)"
          globeMaterial={globeMaterial}
          showAtmosphere={false}
          hexPolygonsData={LAND}
          hexPolygonUseDots
          hexPolygonResolution={3}
          hexPolygonMargin={0.4}
          hexPolygonAltitude={0.005}
          hexPolygonColor={() => "#FFD369"}
          pointsData={discoveries}
          pointLat={(d) => (d as Discovery).lat}
          pointLng={(d) => (d as Discovery).lng}
          pointColor={(d) => tiers?.[(d as Discovery).tier].color ?? "#FFD369"}
          pointAltitude={(d) => {
            const t = (d as Discovery).tier;
            return t === "wonder" ? 0.14 : t === "legendary" ? 0.1 : 0.06;
          }}
          pointRadius={(d) => {
            const t = (d as Discovery).tier;
            return t === "wonder" || t === "legendary" ? 0.5 : 0.35;
          }}
          pointLabel={(d) => {
            const m = d as Discovery;
            return `${m.name} — ${tiers?.[m.tier].label ?? m.tier}`;
          }}
          onGlobeReady={configureControls}
        />
      </div>

      {/* The selected monument, name front and centre, with a Wikipedia link. */}
      {selectedDisc && tiers && (
        <div className="shrink-0 rounded-lg border border-border bg-card/50 p-3.5">
          <div className="flex items-start gap-2.5">
            <span
              className="mt-1 inline-block size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: tiers[selectedDisc.tier].color }}
            />
            <div className="min-w-0 flex-1">
              <p className="text-base font-semibold leading-tight text-ink">{selectedDisc.name}</p>
              <p className="mt-0.5 text-xs text-ink-3">
                {selectedDisc.city}, {selectedDisc.country} · {tiers[selectedDisc.tier].label}
                {selectedDisc.sightings > 1 ? ` · seen ×${selectedDisc.sightings}` : ""}
              </p>
              <a
                href={wikiUrl(selectedDisc.name)}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-2 inline-flex items-center gap-1.5 text-sm font-medium text-sun-strong hover:underline"
              >
                <ExternalLink className="size-3.5" /> Read on Wikipedia
              </a>
            </div>
          </div>
        </div>
      )}

      {/* The collection itself — monuments first, rarest at the top. Click a row
          to fly the globe to it; the ↗ opens its Wikipedia article. */}
      {sorted.length > 0 && tiers && (
        <div className="flex min-h-0 flex-1 flex-col gap-1">
          <h3 className="shrink-0 text-xs font-medium uppercase tracking-wide text-ink-3">
            Monuments · {discoveries.length}
          </h3>
          {/* The list fills the space left under the (small, pinned) globe and
              scrolls on its own, so a big collection never pushes the globe away. */}
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {sorted.map((d) => (
              <div
                key={d.id}
                className={`group flex items-center gap-2.5 rounded-md pr-1 transition-colors hover:bg-card ${
                  selected === d.id ? "bg-card" : ""
                }`}
              >
                <button
                  type="button"
                  onClick={() => focus(d)}
                  className="flex min-w-0 flex-1 items-center gap-2.5 px-2 py-1.5 text-left"
                >
                  <span
                    className="inline-block size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: tiers[d.tier].color }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-ink-2">{d.name}</span>
                    <span className="block truncate text-xs text-ink-3">
                      {d.city}, {d.country} · {tiers[d.tier].label}
                      {d.sightings > 1 ? ` · ×${d.sightings}` : ""}
                    </span>
                  </span>
                </button>
                <a
                  href={wikiUrl(d.name)}
                  target="_blank"
                  rel="noreferrer noopener"
                  title={`Read about ${d.name} on Wikipedia`}
                  aria-label={`Read about ${d.name} on Wikipedia`}
                  className="shrink-0 rounded p-1.5 text-ink-4 opacity-0 transition-opacity hover:text-sun-strong focus-visible:opacity-100 group-hover:opacity-100"
                >
                  <ExternalLink className="size-3.5" />
                </a>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tier progress, demoted to a quiet one-line footnote under the list. */}
      {discoveries.length > 0 && tiers && (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-t border-border pt-2.5 text-xs text-ink-3">
          {tierOrder.map((t) => (
            <span key={t} className="inline-flex items-center gap-1">
              <span
                className="inline-block size-2 rounded-full"
                style={{ backgroundColor: tiers[t].color }}
              />
              {tiers[t].label} {discoveries.filter((d) => d.tier === t).length}/
              {data?.totals[t] ?? 0}
            </span>
          ))}
        </div>
      )}

      {discoveries.length === 0 && !loading && (
        <p className="rounded-lg border border-dashed border-border p-4 text-center text-sm text-ink-3">
          No monuments yet. Publish a prototype to main and the world starts filling in.
        </p>
      )}
    </>
  );
}
