import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ChevronDown, Plus, Square } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { pickableModels, pickerLabel } from "../model-picker";
import type { SkillMeta } from "../useSkills";
import { MODELS, type ModelOption } from "../useSettings";

export interface SlashCommand {
  name: string;
  desc: string;
}

interface MergedItem {
  name: string;
  desc: string;
  kind: "command" | "skill";
  argumentHint?: string;
}

export interface ComposerProps {
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  onStop: () => void;
  /** Disabled while a permission prompt is awaiting an answer. */
  disabled?: boolean;
  model: string;
  /** The selectable models (the engine registry, once settings load). */
  models?: ModelOption[];
  onModelChange: (id: string) => void;
  /** Open Settings on the API-keys section (the "＋ Add API keys…" item). */
  onAddKeys: () => void;
  autoFocus?: boolean;
  /** Built-in slash commands (open panels, new chat) — run immediately on select. */
  commands: SlashCommand[];
  /** Saved skills — selecting inserts `/<name> ` so the user can add arguments. */
  skills: SkillMeta[];
  /** Run a built-in command by name. */
  onRunCommand: (name: string) => void;
}

export function Composer({
  draft,
  setDraft,
  onSubmit,
  busy,
  onStop,
  disabled,
  model,
  models = MODELS,
  onModelChange,
  onAddKeys,
  autoFocus,
  commands,
  skills,
  onRunCommand,
}: ComposerProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [draft]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  // Slash menu is active while the draft is a single "/token" (no space yet).
  const token = draft.startsWith("/") && !draft.includes(" ") ? draft.slice(1).toLowerCase() : null;

  const items = useMemo<MergedItem[]>(() => {
    if (token === null) return [];
    const all: MergedItem[] = [
      ...commands.map((c) => ({ name: c.name, desc: c.desc, kind: "command" as const })),
      ...skills.map((s) => ({
        name: s.name,
        desc: s.description,
        kind: "skill" as const,
        argumentHint: s.argumentHint,
      })),
    ];
    return all.filter((c) => c.name.toLowerCase().startsWith(token));
  }, [token, commands, skills]);

  const menuOpen = token !== null && !dismissed && items.length > 0;
  const menuSel = Math.min(sel, Math.max(0, items.length - 1));

  // Reset the highlight / un-dismiss when the typed token changes.
  useEffect(() => {
    setSel(0);
    setDismissed(false);
  }, [token]);

  // Keep the highlighted row in view as the selection moves with the arrows.
  useEffect(() => {
    if (!menuOpen) return;
    listRef.current?.querySelector(`[data-idx="${menuSel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [menuSel, menuOpen]);

  const accept = (item: MergedItem) => {
    if (item.kind === "command") {
      onRunCommand(item.name);
      setDraft("");
    } else {
      setDraft(`/${item.name} `); // skill — leave room for arguments
      taRef.current?.focus();
    }
    setDismissed(true);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSel((s) => (s + 1) % items.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setSel((s) => (s - 1 + items.length) % items.length);
        return;
      }
      if (e.key === "Tab") {
        e.preventDefault();
        setDraft(`/${items[menuSel].name} `);
        setDismissed(true);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        accept(items[menuSel]);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  const canSend = !!draft.trim() && !busy;

  return (
    <div className="relative">
      {menuOpen && (
        <div className="absolute bottom-full left-0 right-0 mb-2 overflow-hidden rounded-xl border border-border bg-popover p-1 shadow-xl">
          <div ref={listRef} className="max-h-72 overflow-y-auto">
            {items.map((it, i) => {
              // Section header before the first item of each kind.
              const firstOfKind = items.findIndex((x) => x.kind === it.kind) === i;
              return (
                <div key={`${it.kind}:${it.name}`}>
                  {firstOfKind && (
                    <p className="px-3 pb-1 pt-2 text-xs font-medium text-ink-4">
                      {it.kind === "command" ? "Commands" : "Skills"}
                    </p>
                  )}
                  <button
                    data-idx={i}
                    onMouseEnter={() => setSel(i)}
                    onClick={() => accept(it)}
                    className={cn(
                      "flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left",
                      i === menuSel ? "bg-white/[0.06]" : "hover:bg-white/[0.03]",
                    )}
                  >
                    <span className="font-mono text-sm text-ink">/{it.name}</span>
                    {it.argumentHint && (
                      <span className="font-mono text-xs text-ink-4">{it.argumentHint}</span>
                    )}
                    <span className="ml-auto truncate text-xs text-ink-3">{it.desc}</span>
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div
        className={cn(
          "rounded-2xl border border-border bg-card shadow-lg transition-colors",
          "focus-within:border-white/15",
        )}
      >
        <textarea
          ref={taRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Message Hemiunu…  (/ for commands)"
          rows={1}
          disabled={disabled}
          className={cn(
            "block w-full resize-none bg-transparent px-5 pt-4 pb-1 text-[15px] leading-relaxed text-ink outline-none",
            "placeholder:text-ink-4 disabled:opacity-50",
          )}
        />
        <div className="flex items-center justify-between px-3 pb-3 pt-1">
          <DropdownMenu>
            {/* The closed trigger never lies: a selection whose key was removed
                stays shown, marked "(key missing)" (pickerLabel). */}
            <DropdownMenuTrigger className="inline-flex min-w-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-3 outline-none transition-colors hover:bg-accent hover:text-ink">
              {/* Long gateway/model ids: truncate, full label on hover. */}
              <span className="max-w-56 truncate" title={pickerLabel(model, models)}>
                {pickerLabel(model, models)}
              </span>
              <ChevronDown className="size-3.5 shrink-0 opacity-70" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="min-w-44">
              {pickableModels(models).map((m) => (
                <DropdownMenuItem key={m.id} onSelect={() => onModelChange(m.id)}>
                  <span className="max-w-64 truncate" title={m.label}>
                    {m.label}
                  </span>
                </DropdownMenuItem>
              ))}
              {pickableModels(models).length === 0 && (
                <p className="px-2 py-1.5 text-xs text-ink-4">
                  No models available — add an API key to unlock them.
                </p>
              )}
              <DropdownMenuSeparator />
              <DropdownMenuItem className="text-sun" onSelect={onAddKeys}>
                <Plus className="size-3.5" />
                Add API keys…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>

          {busy ? (
            <button
              onClick={onStop}
              aria-label="Stop"
              className="grid size-9 place-items-center rounded-full bg-ink text-ground transition-colors hover:bg-destructive hover:text-destructive-foreground"
            >
              <Square size={14} fill="currentColor" />
            </button>
          ) : (
            <button
              onClick={onSubmit}
              disabled={!canSend}
              aria-label="Send"
              className={cn(
                "grid size-9 place-items-center rounded-full transition-all active:scale-95",
                canSend
                  ? "bg-primary text-primary-foreground hover:bg-sun-strong"
                  : "cursor-default bg-raised text-ink-4",
              )}
            >
              <ArrowUp size={17} strokeWidth={2.5} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
