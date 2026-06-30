import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph3D from "react-force-graph-3d";
import SpriteText from "three-spritetext";
import { Loader2, Plus, RotateCcw, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { getJSON, sendJSON } from "@/lib/api";
import { Markdown } from "@/Markdown";
import { type MemoryNode, type MemoryNodeKind, useMemoryGraph } from "@/useMemoryGraph";

// Distinct roles read at a glance: the main agent is the gold hub, subagents
// are cyan, the files you author (context) are violet, the rest of memory slate.
const GOLD = "#FFD369"; // main agent + "can edit" edges
const CYAN = "#5FBEDB"; // subagents + delegation edges
const LAVENDER = "#C3A6F2"; // context files (yours)
const SLATE = "#AEB6C2"; // other memory files

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

const isMain = (n: MemoryNode) => n.id === "agent:main";

function colorOf(n: MemoryNode): string {
  if (n.kind === "agent") return isMain(n) ? GOLD : CYAN;
  if (n.kind === "context") return LAVENDER;
  return SLATE;
}

type Access = "read" | "write" | "delegate";
const accOf = (l: unknown): Access => (l as { access?: Access }).access ?? "read";
// Translucent stroke for the line; solid for arrows/particles.
function linkStroke(a: Access): string {
  return a === "delegate"
    ? "rgba(95,190,219,0.6)"
    : a === "write"
      ? "rgba(255,211,105,0.55)"
      : "rgba(238,238,238,0.28)";
}
function linkSolid(a: Access): string {
  return a === "delegate" ? CYAN : a === "write" ? GOLD : "rgba(238,238,238,0.6)";
}

// Stable (module-scope) accessors — passing the SAME function identity every
// render stops react-force-graph from rebuilding node sprites on each resize
// (e.g. every frame of the panel slide), keeping interaction fluid.
const nodeColorAcc = (n: object) => colorOf(n as MemoryNode);
const nodeValAcc = (n: object) => {
  const m = n as MemoryNode;
  return m.kind !== "agent" ? 5 : isMain(m) ? 22 : 9;
};
const nodeLabelObj = (n: object) => {
  const m = n as MemoryNode;
  const main = isMain(m);
  const agent = m.kind === "agent";
  const s = new SpriteText(m.label + (m.customized ? " ✎" : ""));
  s.color = agent ? colorOf(m) : m.kind === "context" ? LAVENDER : "#EEEEEE";
  s.textHeight = main ? 7.5 : agent ? 5 : 3.4;
  s.fontFace = "Ubuntu, sans-serif";
  s.fontWeight = agent ? "600" : "400";
  s.position.set(0, main ? 22 : agent ? 15 : 10, 0); // clear of the sphere
  return s;
};
const linkColorAcc = (l: object) => linkStroke(accOf(l));
const linkWidthAcc = (l: object) => {
  const a = accOf(l);
  return a === "delegate" ? 2.2 : a === "write" ? 1.4 : 1.0;
};
const linkSolidAcc = (l: object) => linkSolid(accOf(l));

/** The drawer/graph split width (also the slide target). */
const PANEL_W = "min(600px, 50vw)";

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
  const openNode = useCallback(
    (n: object) => setDrawer({ mode: "node", id: (n as MemoryNode).id }),
    [],
  );

  // Slide the panel in/out by animating the slot width, and keep the last
  // content mounted through the close animation (`render`), like the rail panels.
  const [render, setRender] = useState<Drawer>(null);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    if (drawer) {
      setRender(drawer);
      const id = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(id);
    }
    setShown(false); // width → 0; onTransitionEnd clears `render`
  }, [drawer]);

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      <div ref={wrapRef} className="relative min-w-0 flex-1">
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
            nodeColor={nodeColorAcc}
            nodeVal={nodeValAcc}
            // Bigger spheres = a forgiving click target, so a single click lands
            // on the node instead of just missing into empty space.
            nodeRelSize={6}
            nodeOpacity={1}
            nodeResolution={16}
            // Always-on text labels so the graph reads at a glance (no hover needed).
            nodeThreeObjectExtend
            nodeThreeObject={nodeLabelObj}
            // Edges: cyan = main delegates to a subagent, gold = the agent can edit
            // the file, grey = read-only. Flow particles travel source → target.
            linkColor={linkColorAcc}
            linkWidth={linkWidthAcc}
            linkDirectionalParticles={2}
            linkDirectionalParticleWidth={2}
            linkDirectionalParticleColor={linkSolidAcc}
            linkDirectionalArrowLength={3.5}
            linkDirectionalArrowRelPos={0.9}
            linkDirectionalArrowColor={linkSolidAcc}
            enableNodeDrag={false}
            onNodeClick={openNode}
            // Click empty space to close (no DOM backdrop over the canvas).
            onBackgroundClick={closeDrawer}
            cooldownTicks={120}
          />
        )}

        {/* Title + hint */}
        <div className="pointer-events-none absolute left-5 top-4 z-10">
          <h2 className="font-serif text-xl text-ink">Memory</h2>
          <p className="text-xs text-ink-3">Drag to rotate · scroll to zoom · click a node</p>
        </div>

        {/* Add a context file (extra knowledge attached to agents). z-10 keeps it
          clickable above the WebGL canvas. */}
        <Button
          size="sm"
          className="absolute right-5 top-4 z-10 gap-1.5"
          onClick={() => setDrawer({ mode: "create" })}
        >
          <Plus className="size-4" /> Add to memory
        </Button>

        {/* Legend */}
        <div className="pointer-events-none absolute bottom-4 left-5 z-10 flex flex-col gap-1 text-xs text-ink-3">
          {(
            [
              ["Main agent", GOLD],
              ["Subagent", CYAN],
              ["Context file (yours)", LAVENDER],
              ["Memory file", SLATE],
            ] as const
          ).map(([label, color]) => (
            <span key={label} className="flex items-center gap-2">
              <span className="inline-block size-2.5 rounded-full" style={{ background: color }} />
              {label}
            </span>
          ))}
          {(
            [
              ["delegates", CYAN],
              ["can edit", GOLD],
              ["reads", "rgba(238,238,238,0.55)"],
            ] as const
          ).map(([label, color], i) => (
            <span key={label} className={`flex items-center gap-2 ${i === 0 ? "mt-1.5" : ""}`}>
              <span className="inline-block h-0.5 w-4" style={{ background: color }} />
              edge → {label}
            </span>
          ))}
        </div>
      </div>

      {/* Detail drawer — a flex sibling (so opening it shrinks the graph, which
          its ResizeObserver refits and the camera keeps centered) that slides in
          by animating its width, like the rail panels. `render` keeps the last
          content mounted through the close animation. */}
      {render && (
        <div
          className="shrink-0 overflow-hidden"
          style={{
            width: shown ? PANEL_W : 0,
            transition: "width 0.4s cubic-bezier(0.22, 1, 0.36, 1)",
          }}
          onTransitionEnd={(e) => {
            if (!shown && e.propertyName === "width" && e.target === e.currentTarget) {
              setRender(null);
            }
          }}
        >
          <aside
            style={{ width: PANEL_W }}
            className="relative flex h-full flex-col gap-4 overflow-y-auto border-l border-border bg-rail p-6 shadow-pop"
          >
            <button
              type="button"
              aria-label="Close"
              onClick={closeDrawer}
              className="absolute right-4 top-4 text-ink-3 opacity-70 transition-opacity hover:opacity-100"
            >
              <X className="size-4" />
            </button>
            {render.mode === "node" && (
              <NodeDetailPanel
                id={render.id}
                onClose={closeDrawer}
                onChanged={() => {
                  void refresh();
                }}
              />
            )}
            {render.mode === "create" && (
              <CreateContextPanel
                agents={agentNames}
                onClose={closeDrawer}
                onCreated={() => {
                  void refresh();
                  closeDrawer();
                }}
              />
            )}
          </aside>
        </div>
      )}
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

      {detail.kind === "agent" && (
        <p className="text-xs text-ink-3">
          This is the agent's live system prompt (view-only). To add to it, create a context file
          attached to this agent.
        </p>
      )}

      {detail.kind === "persona" && (
        <p className="text-xs text-ink-3">
          The persona ships with the app and is view-only. To add to the main agent, create a
          context file attached to <strong>main</strong>.
        </p>
      )}

      {detail.kind === "source" && (
        <p className="text-xs text-ink-3">
          A cached map of a connected source — key pages/ids and how to query it — so the agent
          searches it efficiently. Generated by <strong>/scan</strong>; only shown while that source
          is connected.
        </p>
      )}

      {editing ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="min-h-80 flex-1 font-mono text-[13px]"
        />
      ) : (
        <div className="memory-md flex-1 overflow-y-auto rounded-lg border border-border bg-card/40 p-3.5">
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
        <SheetTitle>Add to memory</SheetTitle>
        <SheetDescription>
          A context file — extra knowledge injected into the agents you attach it to, every turn.
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
