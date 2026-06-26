import { useEffect, useState } from "react";
import { ArrowLeft, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { getJSON, sendJSON } from "@/lib/api";
import type { SkillMeta } from "../../useSkills";

interface SkillsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  skills: SkillMeta[];
  /** Built-in slash commands, shown read-only for reference. */
  commands: { name: string; desc: string }[];
  onChanged: () => void;
}

interface Draft {
  name: string;
  description: string;
  argumentHint: string;
  body: string;
  /** True when editing an existing skill (name is then read-only). */
  existing: boolean;
}

const BLANK: Draft = { name: "", description: "", argumentHint: "", body: "", existing: false };

export function SkillsPanel({ open, onOpenChange, skills, commands, onChanged }: SkillsPanelProps) {
  const [editing, setEditing] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setEditing(null);
      setError(null);
    }
  }, [open]);

  const openNew = () => {
    setError(null);
    setEditing({ ...BLANK });
  };

  const openEdit = async (name: string) => {
    setError(null);
    setBusy(true);
    try {
      const s = await getJSON<{
        name: string;
        description: string;
        argumentHint?: string;
        body: string;
      }>(`/api/skills/${name}`);
      setEditing({
        name: s.name,
        description: s.description ?? "",
        argumentHint: s.argumentHint ?? "",
        body: s.body ?? "",
        existing: true,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!editing) return;
    const slug = editing.name.trim();
    if (!slug) return setError("A command name is required.");
    if (!editing.body.trim()) return setError("The skill body is required.");
    setBusy(true);
    setError(null);
    try {
      await sendJSON(
        `/api/skills/${encodeURIComponent(slug)}`,
        {
          description: editing.description,
          argumentHint: editing.argumentHint || undefined,
          body: editing.body,
        },
        "PUT",
      );
      onChanged();
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (name: string) => {
    setBusy(true);
    setError(null);
    try {
      await fetch(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" });
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SheetHeader>
          <SheetTitle>
            {editing ? (editing.existing ? `/${editing.name}` : "New skill") : "Commands & skills"}
          </SheetTitle>
          <SheetDescription>
            {editing
              ? "A skill is a saved instruction you run as /command. Use $ARGUMENTS where the input goes."
              : "Run any of these by typing / in the composer. Skills are editable; built-ins are fixed."}
          </SheetDescription>
        </SheetHeader>

        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {editing ? (
          <EditForm
            draft={editing}
            setDraft={setEditing}
            onSave={save}
            onCancel={() => setEditing(null)}
            busy={busy}
          />
        ) : (
          <>
            {/* Skills */}
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-ink-2">Your skills</h3>
              <Button size="sm" onClick={openNew}>
                <Plus className="size-4" /> New skill
              </Button>
            </div>
            <div className="flex flex-col gap-1">
              {skills.length === 0 && (
                <p className="px-1 text-sm text-ink-3">
                  No skills yet — create one to run it as /name.
                </p>
              )}
              {skills.map((s) => (
                <div
                  key={s.name}
                  className="group flex items-center gap-3 rounded-lg border border-transparent px-3 py-2.5 hover:border-border hover:bg-accent"
                >
                  <button
                    onClick={() => openEdit(s.name)}
                    className="flex min-w-0 flex-1 flex-col text-left"
                  >
                    <span className="font-mono text-sm text-ink">/{s.name}</span>
                    <span className="truncate text-xs text-ink-3">{s.description || "—"}</span>
                  </button>
                  <button
                    onClick={() => openEdit(s.name)}
                    className="shrink-0 rounded p-1 text-ink-4 opacity-0 hover:text-ink group-hover:opacity-100"
                    aria-label={`Edit ${s.name}`}
                  >
                    <Pencil className="size-4" />
                  </button>
                  <button
                    onClick={() => remove(s.name)}
                    className="shrink-0 rounded p-1 text-ink-4 opacity-0 hover:text-destructive group-hover:opacity-100"
                    aria-label={`Delete ${s.name}`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                </div>
              ))}
            </div>

            {/* Built-in commands (read-only) */}
            <div className="mt-2">
              <h3 className="mb-1.5 text-sm font-medium text-ink-2">Built-in commands</h3>
              <div className="flex flex-col">
                {commands.map((c) => (
                  <div key={c.name} className="flex items-center gap-3 px-3 py-1.5">
                    <span className="font-mono text-sm text-ink-2">/{c.name}</span>
                    <span className="ml-auto truncate text-xs text-ink-3">{c.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </>
        )}
    </>
  );
}

interface EditFormProps {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  busy: boolean;
}

function EditForm({ draft, setDraft, onSave, onCancel, busy }: EditFormProps) {
  return (
    <div className="flex flex-col gap-3">
      <button
        onClick={onCancel}
        className="flex w-fit items-center gap-1 text-sm text-ink-3 hover:text-ink"
      >
        <ArrowLeft className="size-4" /> Back
      </button>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-name">
          Command name {draft.existing && <Badge variant="secondary">/{draft.name}</Badge>}
        </Label>
        <Input
          id="skill-name"
          placeholder="weekly-report"
          value={draft.name}
          disabled={draft.existing}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-desc">Description</Label>
        <Input
          id="skill-desc"
          placeholder="What it does + when to use it"
          value={draft.description}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-hint">Argument hint (optional)</Label>
        <Input
          id="skill-hint"
          placeholder="[week]"
          value={draft.argumentHint}
          onChange={(e) => setDraft({ ...draft, argumentHint: e.target.value })}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="skill-body">Instructions</Label>
        <Textarea
          id="skill-body"
          placeholder={"Step-by-step instructions.\nUse $ARGUMENTS where the user's input goes."}
          value={draft.body}
          onChange={(e) => setDraft({ ...draft, body: e.target.value })}
          className="min-h-64 font-mono text-[13px]"
        />
      </div>

      <Button onClick={onSave} disabled={busy} className="self-start">
        {busy ? <Loader2 className="size-4 animate-spin" /> : null}
        Save skill
      </Button>
    </div>
  );
}
