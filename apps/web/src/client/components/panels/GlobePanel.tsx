import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2, MapPin } from "lucide-react";
import Globe, { type GlobeMethods } from "react-globe.gl";
import * as THREE from "three";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getJSON } from "@/lib/api";
import worldData from "@/assets/world.geo.json";

// The land of the dotted morph-globe: the same world GeoJSON the flat map used,
// rendered as react-globe.gl's hex-dot polygons (the "GlobeMorph" tech-globe
// look) — no satellite texture, so it stays offline and on-theme.
const LAND = (worldData as { features: object[] }).features;

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
  const [size, setSize] = useState(360);

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
      if (w > 0) setSize(Math.min(w, 620));
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

  const focus = useCallback((d: Discovery) => {
    setSelected(d.id);
    globeRef.current?.pointOfView({ lat: d.lat, lng: d.lng, altitude: 1.6 }, 900);
  }, []);

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

      {/* The globe */}
      <div
        ref={wrapRef}
        className="flex justify-center overflow-hidden rounded-lg border border-border bg-card/30"
      >
        <Globe
          ref={globeRef}
          width={size}
          height={size}
          backgroundColor="rgba(0,0,0,0)"
          globeMaterial={globeMaterial}
          showAtmosphere
          atmosphereColor="#FFD369"
          atmosphereAltitude={0.13}
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
          onPointClick={(d) => focus(d as Discovery)}
          onGlobeReady={configureControls}
        />
      </div>

      {/* Selected monument detail */}
      {selectedDisc && tiers && (
        <div className="rounded-lg border border-border bg-card/50 p-3">
          <div className="flex items-center gap-2">
            <span
              className="inline-block size-3 shrink-0 rounded-full"
              style={{ backgroundColor: tiers[selectedDisc.tier].color }}
            />
            <div>
              <p className="text-sm font-medium text-ink-2">{selectedDisc.name}</p>
              <p className="text-xs text-ink-3">
                {selectedDisc.city}, {selectedDisc.country} · {tiers[selectedDisc.tier].label}
                {selectedDisc.sightings > 1 ? ` · ×${selectedDisc.sightings}` : ""}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Legend + per-tier progress (click a tier's monuments to fly there) */}
      <div className="flex flex-col gap-1.5">
        <h3 className="text-sm font-medium text-ink-2">Collection</h3>
        {tierOrder.map((t) => {
          const meta = tiers?.[t];
          const owned = discoveries.filter((d) => d.tier === t);
          const tot = data?.totals[t] ?? 0;
          return (
            <div key={t} className="flex items-center gap-2 text-sm">
              <span
                className="inline-block size-3 rounded-full"
                style={{ backgroundColor: meta?.color }}
              />
              <span className="text-ink-2">{meta?.label}</span>
              <span className="ml-auto tabular-nums text-ink-3">
                {owned.length}/{tot}
              </span>
            </div>
          );
        })}
      </div>

      {/* Owned monuments — click to spin the globe to one */}
      {discoveries.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {discoveries.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => focus(d)}
              className="rounded-full border border-border px-2 py-0.5 text-xs text-ink-2 transition-colors hover:bg-card"
              style={selected === d.id ? { borderColor: tiers?.[d.tier].color } : undefined}
            >
              {d.name}
            </button>
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
