import { useEffect, useRef } from "react";
import { ArrowUp, ChevronDown, Square } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { MODELS, modelLabel } from "../useSettings";

export interface ComposerProps {
  draft: string;
  setDraft: (v: string) => void;
  onSubmit: () => void;
  busy: boolean;
  onStop: () => void;
  /** Disabled while a permission prompt is awaiting an answer. */
  disabled?: boolean;
  model: string;
  onModelChange: (id: string) => void;
  autoFocus?: boolean;
}

/**
 * The message composer: an auto-growing textarea inside a rounded card, with a
 * model selector and the send/stop control on the bottom row. Used both centered
 * on the home screen and docked at the bottom once a conversation is underway.
 */
export function Composer({
  draft,
  setDraft,
  onSubmit,
  busy,
  onStop,
  disabled,
  model,
  onModelChange,
  autoFocus,
}: ComposerProps) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
  }, [draft]);

  useEffect(() => {
    if (autoFocus) taRef.current?.focus();
  }, [autoFocus]);

  const canSend = !!draft.trim() && !busy;

  return (
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
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder="Message Hemiunu…"
        rows={1}
        disabled={disabled}
        className={cn(
          "block w-full resize-none bg-transparent px-5 pt-4 pb-1 text-[15px] leading-relaxed text-ink outline-none",
          "placeholder:text-ink-4 disabled:opacity-50",
        )}
      />
      <div className="flex items-center justify-between px-3 pb-3 pt-1">
        <DropdownMenu>
          <DropdownMenuTrigger className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-ink-3 outline-none transition-colors hover:bg-accent hover:text-ink">
            {modelLabel(model)}
            <ChevronDown className="size-3.5 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="min-w-44">
            {MODELS.map((m) => (
              <DropdownMenuItem key={m.id} onSelect={() => onModelChange(m.id)}>
                {m.label}
              </DropdownMenuItem>
            ))}
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
                ? "bg-primary text-primary-foreground hover:bg-clay-strong"
                : "cursor-default bg-raised text-ink-4",
            )}
          >
            <ArrowUp size={17} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}
