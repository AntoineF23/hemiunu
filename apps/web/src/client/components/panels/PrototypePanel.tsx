import { useCallback, useEffect, useState } from "react";
import { Loader2, NotebookPen, Pencil, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { Markdown } from "../../Markdown";

interface PrototypeData {
  team: string | null;
  meta: Record<string, string>;
  body: string;
  raw: string;
}

const KINDS = [
  { id: "decision", label: "Decision" },
  { id: "question", label: "Open question" },
  { id: "feedback", label: "Feedback" },
  { id: "note", label: "Note" },
];

interface PrototypePanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function PrototypePanel({ open }: PrototypePanelProps) {
  const [data, setData] = useState<PrototypeData | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [flash, setFlash] = useState<string | null>(null);

  const [kind, setKind] = useState("note");
  const [note, setNote] = useState("");
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await getJSON<PrototypeData>("/api/prototype"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) {
      setFlash(null);
      setEditing(false);
      void load();
    }
  }, [open, load]);

  const addNote = async () => {
    if (!note.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const { message } = await sendJSON<{ message: string }>("/api/prototype/note", {
        kind,
        text: note.trim(),
      });
      setNote("");
      setFlash(message);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const saveBody = async () => {
    setBusy(true);
    setError(null);
    try {
      const { message } = await sendJSON<{ message: string }>(
        "/api/prototype",
        { content: editBody },
        "PUT",
      );
      setEditing(false);
      setFlash(message);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const meta = data?.meta ?? {};

  return (
    <>
      <SheetHeader>
        <SheetTitle>{meta.title || "Prototype"}</SheetTitle>
        <SheetDescription>
          {data?.team ? `PROTOTYPE.md · ${data.team}` : "PROTOTYPE.md · local workspace"}
          {meta.status ? ` · ${meta.status}` : ""}
          {meta.updated ? ` · updated ${meta.updated}` : ""}
        </SheetDescription>
      </SheetHeader>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {flash && (
        <p className="rounded-md border border-oasis/40 bg-oasis/10 px-3 py-2 text-sm text-ink-2">
          {flash}
        </p>
      )}

      {/* Add a note */}
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <Label className="text-ink-2">
          <NotebookPen className="size-4 text-sun" /> Add knowledge
        </Label>
        <div className="flex gap-2">
          <Select value={kind} onValueChange={setKind}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {KINDS.map((k) => (
                <SelectItem key={k.id} value={k.id}>
                  {k.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Textarea
          placeholder="One clear line…"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="min-h-20"
        />
        <Button onClick={addNote} disabled={busy || !note.trim()} className="self-start">
          {busy ? <Loader2 className="size-4 animate-spin" /> : <NotebookPen className="size-4" />}
          Save note
        </Button>
      </div>

      {/* Body view / edit */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-ink-2">Current brief</h3>
        {!editing ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditBody(data?.body ?? "");
              setEditing(true);
            }}
          >
            <Pencil className="size-3.5" /> Edit
          </Button>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        )}
      </div>

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-ink-3">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : editing ? (
        <div className="flex flex-col gap-2">
          <Textarea
            value={editBody}
            onChange={(e) => setEditBody(e.target.value)}
            className="min-h-72 font-mono text-[13px]"
          />
          <Button onClick={saveBody} disabled={busy} className="self-start">
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
            Save brief
          </Button>
        </div>
      ) : (
        <div className="rounded-lg border border-border bg-card/50 p-4">
          {data?.body?.trim() ? (
            <Markdown text={data.body} />
          ) : (
            <p className="text-sm text-ink-3">No PROTOTYPE.md content yet.</p>
          )}
        </div>
      )}
    </>
  );
}
