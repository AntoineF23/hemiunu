import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import { Loader2, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { getJSON, sendJSON } from "@/lib/api";
import { Markdown } from "@/Markdown";
import { type MemoryNode, type MemoryNodeKind, useMemoryGraph } from "@/useMemoryGraph";

// Restrained palette: agents are the gold hubs; files muted; anything the user
// authored/customized takes a warm gold tint so "yours" reads at a glance.
const GOLD = "#FFD369";
const WARM = "#E6B964";
const MUTED = "#B9BDC4";
const COLORS: Record<MemoryNodeKind, string> = {
  agent: GOLD,
  persona: MUTED,
  user: WARM,
  knowledge: MUTED,
  skill: MUTED,
  source: MUTED,
  prototype: WARM,
  context: WARM,
};
const KIND_LABEL: Record<MemoryNodeKind, string> = {
  agent: "Agent",
  persona: "Persona",
  user: "User memory",
  knowledge: "Knowledge",
  skill: "Skill",
  source: "Source map",
  prototype: "Prototype",
  context: "Context file",
};

function colorOf(n: MemoryNode): string {
  if (n.kind === "knowledge" && n.customized) return WARM;
  return COLORS[n.kind] ?? MUTED;
}

interface NodeDetail {
  kind: MemoryNodeKind;
  title: string;
  content: string;
  editable: boolean;
  customized?: boolean;
  original?: string;
  description?: string;
  agents?: string[];
}

type Drawer = { mode: "node"; id: string } | { mode: "create" } | null;

export function MemoryView() {
  const { graph, refresh } = useMemoryGraph();
  const wrapRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 800, h: 600 });
  const [drawer, setDrawer] = useState<Drawer>(null);

  // Fill the available main area, responsively.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  const agentNames = useMemo(
    () => graph.nodes.filter((n) => n.kind === "agent").map((n) => n.label),
    [graph.nodes],
  );

  const closeDrawer = useCallback(() => setDrawer(null), []);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      {graph.nodes.length === 0 ? (
        <div className="flex h-full items-center justify-center text-sm text-ink-3">
          <Loader2 className="mr-2 size-4 animate-spin" /> Loading your memory…
        </div>
      ) : (
        <ForceGraph3D
          width={size.w}
          height={size.h}
          graphData={graph}
          backgroundColor="rgba(0,0,0,0)"
          showNavInfo={false}
          nodeColor={(n) => colorOf(n as MemoryNode)}
          nodeVal={(n) => ((n as MemoryNode).kind === "agent" ? 9 : 3)}
          nodeOpacity={0.95}
          nodeResolution={12}
          nodeLabel={(n) => {
            const m = n as MemoryNode;
            return `<div style="font-family:Ubuntu,sans-serif;font-size:12px;color:#EEE;background:#1b1f24;border:1px solid rgba(238,238,238,.16);padding:4px 8px;border-radius:4px"><b>${m.label}</b> · ${KIND_LABEL[m.kind]}${m.customized ? " · customized" : ""}</div>`;
          }}
          linkColor={() => "rgba(238,238,238,0.18)"}
          linkWidth={0.4}
          linkDirectionalArrowLength={2.6}
          linkDirectionalArrowRelPos={0.85}
          linkDirectionalArrowColor={(l) =>
            (l as { access?: string }).access === "write" ? GOLD : "rgba(238,238,238,0.4)"
          }
          enableNodeDrag={false}
          onNodeClick={(n) => setDrawer({ mode: "node", id: (n as MemoryNode).id })}
          cooldownTicks={120}
        />
      )}

      {/* Title + hint */}
      <div className="pointer-events-none absolute left-5 top-4">
        <h2 className="font-serif text-xl text-ink">Memory</h2>
        <p className="text-xs text-ink-3">Drag to rotate · scroll to zoom · click a node</p>
      </div>

      {/* New context file */}
      <Button
        size="sm"
        className="absolute right-5 top-4 gap-1.5"
        onClick={() => setDrawer({ mode: "create" })}
      >
        <Plus className="size-4" /> Context file
      </Button>

      {/* Legend */}
      <div className="absolute bottom-4 left-5 flex flex-col gap-1 text-xs text-ink-3">
        {(["agent", "context", "knowledge", "skill", "source"] as MemoryNodeKind[]).map((k) => (
          <span key={k} className="flex items-center gap-2">
            <span
              className="inline-block size-2.5 rounded-full"
              style={{ background: k === "agent" ? GOLD : k === "context" ? WARM : MUTED }}
            />
            {KIND_LABEL[k]}
          </span>
        ))}
      </div>

      <Sheet open={drawer !== null} onOpenChange={(o) => !o && closeDrawer()}>
        <SheetContent>
          {drawer?.mode === "node" && (
            <NodeDetailPanel
              id={drawer.id}
              onClose={closeDrawer}
              onChanged={() => {
                void refresh();
              }}
            />
          )}
          {drawer?.mode === "create" && (
            <CreateContextPanel
              agents={agentNames}
              onClose={closeDrawer}
              onCreated={() => {
                void refresh();
                closeDrawer();
              }}
            />
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}

function NodeDetailPanel({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const d = await getJSON<NodeDetail>(`/api/memory/node/${encodeURIComponent(id)}`);
      setDetail(d);
      setDraft(d.content);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await sendJSON(`/api/memory/node/${encodeURIComponent(id)}`, { content: draft }, "PUT");
      onChanged();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (revert: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await sendJSON(`/api/memory/node/${encodeURIComponent(id)}`, undefined, "DELETE");
      onChanged();
      if (revert) await load();
      else onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!detail) {
    return (
      <SheetHeader>
        <SheetTitle>{error ? "Couldn't load" : "Loading…"}</SheetTitle>
        {error && <SheetDescription className="text-destructive">{error}</SheetDescription>}
      </SheetHeader>
    );
  }

  const isContext = detail.kind === "context";
  const isKnowledge = detail.kind === "knowledge";

  return (
    <>
      <SheetHeader>
        <SheetTitle>{detail.title}</SheetTitle>
        <SheetDescription>
          {KIND_LABEL[detail.kind]}
          {detail.customized ? " · customized (overrides the shipped pack)" : ""}
          {detail.description ? ` · ${detail.description}` : ""}
        </SheetDescription>
      </SheetHeader>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {detail.kind === "persona" && (
        <p className="text-xs text-ink-3">
          The persona ships with the app and is view-only. To add to the main agent, create a
          context file attached to <strong>main</strong>.
        </p>
      )}

      {editing ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-80 flex-1 font-mono text-[13px]"
        />
      ) : (
        <div className="flex-1 overflow-y-auto rounded-lg border border-border bg-card/40 p-3">
          {detail.content.trim() ? (
            <Markdown text={detail.content} />
          ) : (
            <p className="text-sm text-ink-3">(empty)</p>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {detail.editable && !editing && (
          <Button size="sm" onClick={() => setEditing(true)}>
            Edit
          </Button>
        )}
        {editing && (
          <>
            <Button size="sm" disabled={busy} onClick={save}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : "Save"}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setDraft(detail.content);
                setEditing(false);
              }}
            >
              Cancel
            </Button>
          </>
        )}
        {isKnowledge && detail.customized && !editing && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => remove(true)}>
            <RotateCcw className="size-4" /> Revert to original
          </Button>
        )}
        {(isContext || detail.kind === "skill" || detail.kind === "source") && !editing && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => remove(false)}>
            <Trash2 className="size-4" /> Delete
          </Button>
        )}
        <Button size="sm" variant="ghost" className="ml-auto" onClick={onClose}>
          <X className="size-4" /> Close
        </Button>
      </div>
    </>
  );
}

function CreateContextPanel({
  agents,
  onClose,
  onCreated,
}: {
  agents: string[];
  onClose: () => void;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = (a: string) =>
    setSelected((s) => (s.includes(a) ? s.filter((x) => x !== a) : [...s, a]));

  const create = async () => {
    if (!title.trim()) return setError("A title is required.");
    if (!selected.length) return setError("Attach it to at least one agent.");
    if (!content.trim()) return setError("Add some content.");
    setBusy(true);
    setError(null);
    try {
      await sendJSON("/api/memory/attachments", { title, description, agents: selected, content });
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>New context file</SheetTitle>
        <SheetDescription>
          Extra context injected into the agents you attach it to, every turn.
        </SheetDescription>
      </SheetHeader>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ctx-title">Title</Label>
        <Input
          id="ctx-title"
          placeholder="e.g. Product glossary"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ctx-desc">Description (optional)</Label>
        <Input
          id="ctx-desc"
          placeholder="One line on what this is"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label>Attach to</Label>
        <div className="flex flex-wrap gap-1.5">
          {agents.map((a) => (
            <button
              key={a}
              type="button"
              onClick={() => toggle(a)}
              className={`border px-2.5 py-1 text-[12.5px] transition-colors ${
                selected.includes(a)
                  ? "border-sun/40 bg-sun-soft font-medium text-sun"
                  : "border-border text-ink-3 hover:text-ink-2"
              }`}
            >
              {a}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="ctx-body">Content</Label>
        <Textarea
          id="ctx-body"
          placeholder="Markdown the agent should always have on hand."
          value={content}
          onChange={(e) => setContent(e.target.value)}
          className="min-h-56 font-mono text-[13px]"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy} onClick={create}>
          {busy ? <Loader2 className="size-4 animate-spin" /> : "Create"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
      </div>
    </>
  );
}
