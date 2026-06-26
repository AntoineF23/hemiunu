import { useCallback, useEffect, useState } from "react";
import {
  FileText,
  KeyRound,
  Loader2,
  Pencil,
  Plug,
  Plus,
  RefreshCw,
  Save,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
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
  /** Raw overlay config (for the edit form), or null for app-default servers. */
  config: McpConfig | null;
  /** Brand domain for the favicon (from the server's URL or a known name). */
  iconDomain: string | null;
  serverPolicy: Policy;
  tools: ToolInfo[];
  sourceMap: { description: string; scanned: string | null } | null;
  /** Remote (http/sse) server with a URL. */
  remote?: boolean;
  /** Reachability probe: false = offline, null = not a remote server. */
  reachable?: boolean | null;
  /** Server returned 401 and we have no token → needs the OAuth flow. */
  needsAuth?: boolean;
  /** We hold an OAuth token for this server. */
  oauthAuthorized?: boolean;
}

interface McpConfig {
  type?: "stdio" | "http" | "sse";
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
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
  return <Plug className={cn("size-4", connected ? "text-oasis" : "text-ink-4")} />;
}

export function McpPanel({ open, onOpenChange }: McpPanelProps) {
  const [servers, setServers] = useState<ServerInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState<string | null>(null);
  const [mapView, setMapView] = useState<{ name: string; body: string } | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<ServerInfo | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState<string | null>(null);

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
      setEditing(null);
      setConfirmDelete(null);
      setFlash(null);
      void load();
    }
  }, [open, load]);

  const removeServer = async (name: string) => {
    setError(null);
    setConfirmDelete(null);
    try {
      await fetch(`/api/mcp/server/${encodeURIComponent(name)}`, { method: "DELETE" });
      if (editing?.name === name) setEditing(null);
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

  // Authorize a remote server via OAuth: open the consent page, then poll until
  // the browser callback completes (or the user gives up after ~5 min).
  const authorize = async (name: string) => {
    setAuthorizing(name);
    setError(null);
    try {
      const { authUrl } = await sendJSON<{ authUrl: string }>("/api/mcp/oauth/start", {
        server: name,
      });
      window.open(authUrl, "_blank", "noopener");
      for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await getJSON<{ authorized: boolean }>(
          `/api/mcp/oauth/status?server=${encodeURIComponent(name)}`,
        );
        if (st.authorized) break;
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAuthorizing(null);
    }
  };

  return (
    <>
      <SheetHeader>
          <SheetTitle>
            {mapView
              ? `${mapView.name} · source map`
              : adding
                ? "Add MCP server"
                : editing
                  ? `Edit ${editing.name}`
                  : "MCP servers"}
          </SheetTitle>
          <SheetDescription>
            {mapView
              ? "What the scanner mapped inside this source."
              : adding
                ? "Connect a new MCP server — it applies on your next message, no restart."
                : editing
                  ? "Change its configuration and edit its scan map."
                  : "Connected tools, their permissions (allow / ask / block), and scan maps."}
          </SheetDescription>
        </SheetHeader>

        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}
        {flash && !adding && !mapView && (
          <p className="rounded-md border border-oasis/40 bg-oasis/10 px-3 py-2 text-sm text-ink-2">
            {flash}
          </p>
        )}

        {adding ? (
          <ServerForm
            onCancel={() => setAdding(false)}
            onDone={async (name) => {
              setAdding(false);
              setFlash(`Added “${name}” — it connects on your next message.`);
              await load();
            }}
            onError={setError}
          />
        ) : editing ? (
          <div className="flex flex-col gap-4">
            <button
              onClick={() => setEditing(null)}
              className="w-fit text-sm text-ink-3 hover:text-ink"
            >
              ← Back to servers
            </button>

            <h3 className="text-sm font-medium text-ink-2">Configuration</h3>
            {editing.userAdded ? (
              <ServerForm
                initial={{ name: editing.name, config: editing.config }}
                showBack={false}
                onCancel={() => setEditing(null)}
                onDone={async () => {
                  setFlash(`Saved ${editing.name}.`);
                  await load();
                }}
                onError={setError}
              />
            ) : (
              <p className="rounded-lg border border-border bg-card/50 px-3 py-2.5 text-sm text-ink-3">
                This server is configured by Hemiunu (mcp.json) and isn't editable here. You can
                still edit its scan map below.
              </p>
            )}

            <h3 className="border-t border-border pt-3 text-sm font-medium text-ink-2">
              Scan map (.md)
            </h3>
            <SourceMapEditor
              name={editing.name}
              hasMap={!!editing.sourceMap}
              onError={setError}
              onChanged={load}
            />
          </div>
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
            <Button size="sm" className="w-fit" onClick={() => setAdding(true)}>
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
                  {/* Remote-server auth diagnostic */}
                  {s.needsAuth ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      disabled={authorizing === s.name}
                      onClick={() => authorize(s.name)}
                      title="Sign in to this server (OAuth)"
                    >
                      {authorizing === s.name ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <KeyRound className="size-3.5" />
                      )}
                      Authorize
                    </Button>
                  ) : s.oauthAuthorized ? (
                    <span
                      className="rounded bg-oasis/15 px-1.5 py-0.5 text-[10px] text-oasis"
                      title="Signed in via OAuth"
                    >
                      ✓ authorized
                    </span>
                  ) : s.remote && s.reachable === false ? (
                    <span className="rounded bg-raised px-1.5 py-0.5 text-[10px] text-ink-3">
                      not reachable
                    </span>
                  ) : null}
                  <div className="ml-auto flex items-center gap-1.5">
                    <button
                      onClick={() => setEditing(s)}
                      aria-label={`Edit ${s.name}`}
                      className="rounded p-1 text-ink-4 hover:text-ink"
                      title="Edit server & scan map"
                    >
                      <Pencil className="size-4" />
                    </button>
                    {s.userAdded && (
                      <button
                        onClick={() => setConfirmDelete(s.name)}
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

        {/* Delete confirmation */}
        <Dialog open={!!confirmDelete} onOpenChange={(o) => !o && setConfirmDelete(null)}>
          <DialogContent className="max-w-sm">
            <DialogHeader>
              <DialogTitle>Remove “{confirmDelete}”?</DialogTitle>
              <DialogDescription>
                This deletes the server from your config and removes its scan map (.md). This can't
                be undone.
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setConfirmDelete(null)}>
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => confirmDelete && removeServer(confirmDelete)}
              >
                <Trash2 className="size-4" /> Remove
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
    </>
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

/** Object → "KEY=value" lines (inverse of parseKV), for prefilling the form. */
function kvToText(obj?: Record<string, string>): string {
  return obj
    ? Object.entries(obj)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n")
    : "";
}

function ServerForm({
  initial,
  showBack = true,
  onCancel,
  onDone,
  onError,
}: {
  /** Present when editing an existing server (name locked, fields prefilled). */
  initial?: { name: string; config: McpConfig | null };
  showBack?: boolean;
  onCancel: () => void;
  onDone: (name: string) => void;
  onError: (msg: string) => void;
}) {
  const cfg = initial?.config ?? null;
  const editing = !!initial;
  const initTransport: Transport = cfg?.type === "http" || cfg?.type === "sse" ? cfg.type : "stdio";

  const [name, setName] = useState(initial?.name ?? "");
  const [transport, setTransport] = useState<Transport>(initTransport);
  const [command, setCommand] = useState(cfg?.command ?? "");
  const [args, setArgs] = useState((cfg?.args ?? []).join("\n"));
  const [url, setUrl] = useState(cfg?.url ?? "");
  const [env, setEnv] = useState(kvToText(cfg?.env));
  const [headers, setHeaders] = useState(kvToText(cfg?.headers));
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
      onDone(name.trim());
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {showBack && (
        <button onClick={onCancel} className="w-fit text-sm text-ink-3 hover:text-ink">
          ← Back to servers
        </button>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="mcp-name">Name</Label>
        <Input
          id="mcp-name"
          placeholder="linear"
          value={name}
          disabled={editing}
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
        {busy ? (
          <Loader2 className="size-4 animate-spin" />
        ) : editing ? (
          <Save className="size-4" />
        ) : (
          <Plus className="size-4" />
        )}
        {editing ? "Save changes" : "Add server"}
      </Button>
    </div>
  );
}

/** Edit (and save / delete) a server's scan source-map .md inline. */
function SourceMapEditor({
  name,
  hasMap,
  onError,
  onChanged,
}: {
  name: string;
  hasMap: boolean;
  onError: (msg: string) => void;
  onChanged: () => void;
}) {
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    getJSON<{ exists: boolean; body: string }>(`/api/mcp/${encodeURIComponent(name)}/sourcemap`)
      .then((m) => alive && setBody(m.exists ? m.body : ""))
      .catch((e) => onError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [name, onError]);

  const save = async () => {
    setBusy(true);
    onError("");
    try {
      await sendJSON(`/api/mcp/${encodeURIComponent(name)}/sourcemap`, { body }, "PUT");
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const clearMap = async () => {
    setBusy(true);
    try {
      await fetch(`/api/mcp/${encodeURIComponent(name)}/sourcemap`, { method: "DELETE" });
      setBody("");
      onChanged();
    } catch (e) {
      onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-ink-3">
        <Loader2 className="size-4 animate-spin" /> Loading…
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="# Source map (Markdown)…"
        className="min-h-72 font-mono text-[13px]"
      />
      <div className="flex items-center gap-2">
        <Button onClick={save} disabled={busy} className="self-start">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
          Save scan map
        </Button>
        {hasMap && (
          <Button variant="ghost" onClick={clearMap} disabled={busy} className="text-ink-3">
            <Trash2 className="size-4" /> Delete map
          </Button>
        )}
        {saved && <span className="text-xs text-oasis">Saved</span>}
      </div>
    </div>
  );
}

const OPTIONS: { value: Policy; label: string; active: string }[] = [
  { value: "allow", label: "Allow", active: "bg-oasis/20 text-oasis" },
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
