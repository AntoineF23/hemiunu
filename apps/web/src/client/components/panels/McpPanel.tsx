import { useCallback, useEffect, useState } from "react";
import { FileText, Loader2, Plug, Plus, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
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
  userAdded: boolean;
  /** Brand domain for the favicon (from the server's URL or a known name). */
  iconDomain: string | null;
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

// MCP has no logo field. The server resolves a brand domain (from the server's
// own URL, or a known-name match) and we pull its favicon; otherwise a plug.
function ServerLogo({ domain, connected }: { domain: string | null; connected: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [domain]);
  if (domain && !failed) {
    return (
      <img
        src={`https://icons.duckduckgo.com/ip3/${domain}.ico`}
        alt=""
        className={cn("size-4 rounded-sm object-contain", !connected && "opacity-40 grayscale")}
        onError={() => setFailed(true)}
      />
    );
  }
  return <Plug className={cn("size-4", connected ? "text-sage" : "text-ink-4")} />;
}

export function McpPanel({ open, onOpenChange }: McpPanelProps) {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState<string | null>(null);
  const [mapView, setMapView] = useState<{ name: string; body: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

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
      setAdding(false);
      setFlash(null);
      void load();
    }
  }, [open, load]);

  const removeServer = async (name: string) => {
    setError(null);
    try {
      await fetch(`/api/mcp/server/${encodeURIComponent(name)}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

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
          <SheetTitle>
            {mapView ? `${mapView.name} · source map` : adding ? "Add MCP server" : "MCP servers"}
          </SheetTitle>
          <SheetDescription>
            {mapView
              ? "What the scanner mapped inside this source."
              : adding
                ? "Connect a new MCP server — it applies on your next message, no restart."
                : "Connected tools, their permissions (allow / ask / block), and scan maps."}
          </SheetDescription>
        </SheetHeader>

        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {flash && !adding && !mapView && (
          <p className="rounded-md border border-sage/40 bg-sage/10 px-3 py-2 text-sm text-ink-2">
            {flash}
          </p>
        )}

        {adding ? (
          <AddServerForm
            onCancel={() => setAdding(false)}
            onAdded={async (name) => {
              setAdding(false);
              setFlash(`Added “${name}” — it connects on your next message.`);
              await load();
            }}
            onError={setError}
          />
        ) : mapView ? (
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
            <Button variant="secondary" size="sm" className="w-fit" onClick={() => setAdding(true)}>
              <Plus className="size-4" /> Add MCP server
            </Button>
            {servers.map((s) => (
              <div
                key={s.name}
                className="flex flex-col gap-3 rounded-xl border border-border p-3.5"
              >
                {/* Header */}
                <div className="flex items-center gap-2.5">
                  <ServerLogo domain={s.iconDomain} connected={s.connected} />
                  <span className="font-medium text-ink">{s.name}</span>
                  {!s.connected && (
                    <span
                      className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-ink-3"
                      title={s.reason ?? undefined}
                    >
                      {s.reason ? `off · ${s.reason}` : "off"}
                    </span>
                  )}
                  <div className="ml-auto flex items-center gap-1.5">
                    {s.userAdded && (
                      <button
                        onClick={() => removeServer(s.name)}
                        aria-label={`Remove ${s.name}`}
                        className="rounded p-1 text-ink-4 hover:text-destructive"
                        title="Remove this server"
                      >
                        <Trash2 className="size-4" />
                      </button>
                    )}
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

type Transport = "stdio" | "http" | "sse";

/** Parse "KEY=value" lines into an object (blank lines ignored). */
function parseKV(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const i = line.indexOf("=");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    if (k) out[k] = line.slice(i + 1).trim();
  }
  return out;
}

function AddServerForm({
  onCancel,
  onAdded,
  onError,
}: {
  onCancel: () => void;
  onAdded: (name: string) => void;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<Transport>("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const [env, setEnv] = useState("");
  const [headers, setHeaders] = useState("");
  const [busy, setBusy] = useState(false);

  const stdio = transport === "stdio";
  const valid = name.trim() && (stdio ? command.trim() : url.trim());

  const submit = async () => {
    setBusy(true);
    onError("");
    const config = stdio
      ? {
          type: "stdio",
          command: command.trim(),
          args: args
            .split("\n")
            .map((a) => a.trim())
            .filter(Boolean),
          ...(env.trim() ? { env: parseKV(env) } : {}),
        }
      : {
          type: transport,
          url: url.trim(),
          ...(headers.trim() ? { headers: parseKV(headers) } : {}),
        };
    try {
      await sendJSON("/api/mcp/server", { name: name.trim(), config });
      onAdded(name.trim());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      <button onClick={onCancel} className="w-fit text-sm text-ink-3 hover:text-ink">
        ← Back to servers
      </button>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mcp-name">Name</Label>
        <Input
          id="mcp-name"
          placeholder="linear"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label>Transport</Label>
        <Select value={transport} onValueChange={(v) => setTransport(v as Transport)}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="stdio">stdio (local command)</SelectItem>
            <SelectItem value="http">http (remote URL)</SelectItem>
            <SelectItem value="sse">sse (remote URL)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {stdio ? (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-cmd">Command</Label>
            <Input
              id="mcp-cmd"
              placeholder="npx"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-args">Arguments (one per line)</Label>
            <Textarea
              id="mcp-args"
              placeholder={"-y\n@some/mcp-server"}
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              className="min-h-20 font-mono text-[13px]"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-env">Environment (KEY=value per line, optional)</Label>
            <Textarea
              id="mcp-env"
              placeholder="API_KEY=sk-…"
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              className="min-h-16 font-mono text-[13px]"
            />
          </div>
        </>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-url">URL</Label>
            <Input
              id="mcp-url"
              placeholder="https://mcp.example.com/sse"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="mcp-headers">Headers (KEY=value per line, optional)</Label>
            <Textarea
              id="mcp-headers"
              placeholder="Authorization=Bearer …"
              value={headers}
              onChange={(e) => setHeaders(e.target.value)}
              className="min-h-16 font-mono text-[13px]"
            />
          </div>
        </>
      )}

      <Button onClick={submit} disabled={busy || !valid} className="self-start">
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Plus className="size-4" />}
        Add server
      </Button>
    </div>
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
