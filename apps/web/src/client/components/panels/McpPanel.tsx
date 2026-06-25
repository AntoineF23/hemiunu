import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2, Plug, PlugZap, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { getJSON, sendJSON } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Markdown } from "../../Markdown";

type Policy = "allow" | "ask" | "block";

interface ToolInfo {
  id: string;
  policy: Policy;
}
interface ServerInfo {
  name: string;
  connected: boolean;
  reason: string | null;
  serverPolicy: Policy;
  tools: ToolInfo[];
  sourceMap: { description: string; scanned: string | null } | null;
}

interface McpPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** `mcp__notion__notion-search` → `notion-search`. */
const shortTool = (id: string) => {
  const rest = id.startsWith("mcp__") ? id.slice(5) : id;
  const i = rest.indexOf("__");
  return i >= 0 ? rest.slice(i + 2) : rest;
};

export function McpPanel({ open, onOpenChange }: McpPanelProps) {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState<string | null>(null);
  const [mapView, setMapView] = useState<{ name: string; body: string } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { servers } = await getJSON<{ servers: ServerInfo[] }>("/api/mcp");
      setServers(servers);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setMapView(null);
      void load();
    }
  }, [open, load]);

  const setPolicy = async (scope: "server" | "tool", key: string, policy: Policy) => {
    // optimistic
    setServers((prev) =>
      prev.map((s) => {
        if (scope === "server" && s.name === key) return { ...s, serverPolicy: policy };
        if (scope === "tool")
          return { ...s, tools: s.tools.map((t) => (t.id === key ? { ...t, policy } : t)) };
        return s;
      }),
    );
    await sendJSON("/api/mcp/policy", { scope, key, policy }).catch(() => load());
  };

  const viewMap = async (name: string) => {
    try {
      const m = await getJSON<{ exists: boolean; body: string }>(`/api/mcp/${name}/sourcemap`);
      setMapView({ name, body: m.exists ? m.body : "_No source map yet — run a scan._" });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const rescan = async (name: string) => {
    setScanning(name);
    setError(null);
    try {
      await sendJSON(`/api/mcp/${name}/scan`, {});
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScanning(null);
    }
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-full !max-w-xl gap-4 overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{mapView ? `${mapView.name} · source map` : "MCP servers"}</SheetTitle>
          <SheetDescription>
            {mapView
              ? "What the scanner mapped inside this source."
              : "Connected tools, their permissions (allow / ask / block), and scan maps."}
          </SheetDescription>
        </SheetHeader>

        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {mapView ? (
          <div className="flex flex-col gap-3">
            <Button variant="ghost" size="sm" className="w-fit" onClick={() => setMapView(null)}>
              ← Back to servers
            </Button>
            <div className="rounded-lg border border-border bg-card/50 p-4">
              <Markdown text={mapView.body} />
            </div>
          </div>
        ) : loading ? (
          <p className="flex items-center gap-2 text-sm text-ink-3">
            <Loader2 className="size-4 animate-spin" /> Loading…
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {servers.map((s) => (
              <div key={s.name} className="flex flex-col gap-3 rounded-xl border border-border p-3.5">
                {/* Header */}
                <div className="flex items-center gap-2.5">
                  {s.connected ? (
                    <PlugZap className="size-4 text-sage" />
                  ) : (
                    <Plug className="size-4 text-ink-4" />
                  )}
                  <span className="font-medium text-ink">{s.name}</span>
                  {!s.connected && (
                    <span
                      className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-ink-3"
                      title={s.reason ?? undefined}
                    >
                      {s.reason ? `off · ${s.reason}` : "off"}
                    </span>
                  )}
                  <div className="ml-auto">
                    <PolicyToggle
                      value={s.serverPolicy}
                      onChange={(p) => setPolicy("server", s.name, p)}
                    />
                  </div>
                </div>

                {/* Per-tool overrides (tools observed in use) */}
                {s.tools.length > 0 && (
                  <div className="flex flex-col gap-1.5 border-t border-border pt-2.5">
                    {s.tools.map((t) => (
                      <div key={t.id} className="flex items-center gap-2">
                        <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink-2">
                          {shortTool(t.id)}
                        </span>
                        <PolicyToggle
                          value={t.policy}
                          inherited={s.serverPolicy}
                          onChange={(p) => setPolicy("tool", t.id, p)}
                        />
                      </div>
                    ))}
                  </div>
                )}

                {/* Source map (/scan) */}
                <div className="flex items-center gap-2 border-t border-border pt-2.5 text-xs text-ink-3">
                  {s.sourceMap ? (
                    <span className="truncate">
                      Scanned{s.sourceMap.scanned ? ` ${s.sourceMap.scanned}` : ""} ·{" "}
                      {s.sourceMap.description || "mapped"}
                    </span>
                  ) : (
                    <span>Not scanned yet</span>
                  )}
                  <div className="ml-auto flex shrink-0 gap-1">
                    {s.sourceMap && (
                      <Button variant="ghost" size="sm" onClick={() => viewMap(s.name)}>
                        <FileText className="size-3.5" /> View
                      </Button>
                    )}
                    {s.connected && (
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={scanning === s.name}
                        onClick={() => rescan(s.name)}
                      >
                        {scanning === s.name ? (
                          <Loader2 className="size-3.5 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3.5" />
                        )}
                        {s.sourceMap ? "Rescan" : "Scan"}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {servers.length === 0 && (
              <p className="text-sm text-ink-3">No MCP servers configured.</p>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}

const OPTIONS: { value: Policy; label: string; active: string }[] = [
  { value: "allow", label: "Allow", active: "bg-sage/20 text-sage" },
  { value: "ask", label: "Ask", active: "bg-white/10 text-ink" },
  { value: "block", label: "Block", active: "bg-destructive/20 text-destructive" },
];

function PolicyToggle({
  value,
  inherited,
  onChange,
}: {
  value: Policy;
  /** When set and value is "ask", that means "inherit the server default". */
  inherited?: Policy;
  onChange: (p: Policy) => void;
}) {
  return (
    <div className="flex items-center rounded-md border border-border p-0.5">
      {OPTIONS.map((o) => {
        const isActive = value === o.value;
        const label = o.value === "ask" && inherited ? `Ask` : o.label;
        return (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            title={
              o.value === "ask" && inherited ? `Inherit server default (${inherited})` : o.label
            }
            className={cn(
              "rounded px-2 py-0.5 text-xs font-medium transition-colors",
              isActive ? o.active : "text-ink-4 hover:text-ink-2",
            )}
          >
            {label}
          </button>
        );
      })}
    </div>
  );
}
