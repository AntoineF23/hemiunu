import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquare, Trash2 } from "lucide-react";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { getJSON, sendJSON } from "@/lib/api";

interface Conversation {
  id: string;
  title: string;
  created_at: string;
  model: string;
}

interface ConversationsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResume: (id: string, messages: { role: string; content: string }[]) => void;
  onDeleted: (id: string) => void;
}

export function ConversationsPanel({ open, onResume, onDeleted }: ConversationsPanelProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { conversations } = await getJSON<{ conversations: Conversation[] }>(
        "/api/conversations",
      );
      setConversations(conversations);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
    else setConfirmingId(null);
  }, [open, load]);

  const openConversation = async (id: string) => {
    try {
      const { messages } = await getJSON<{
        messages: { role: string; content: string }[];
      }>(`/api/conversations/${id}`);
      onResume(id, messages);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const deleteConversation = async (id: string) => {
    setError(null);
    try {
      await sendJSON(`/api/conversations/${id}`, undefined, "DELETE");
      setConversations((prev) => prev.filter((c) => c.id !== id));
      setConfirmingId(null);
      onDeleted(id);
      // Re-fetch so the list provably reflects the database, not just local state.
      void load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>Conversations</SheetTitle>
        <SheetDescription>Pick up where you left off.</SheetDescription>
      </SheetHeader>

      {error && (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {loading ? (
        <p className="flex items-center gap-2 text-sm text-ink-3">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </p>
      ) : conversations.length === 0 ? (
        <p className="text-sm text-ink-3">No conversations yet.</p>
      ) : (
        <div className="flex flex-col gap-1">
          {conversations.map((c) => (
            <div
              key={c.id}
              className="group flex items-center gap-1 rounded-lg border border-transparent pr-1 transition-colors hover:border-border hover:bg-accent"
            >
              <button
                onClick={() => openConversation(c.id)}
                className="flex min-w-0 flex-1 items-start gap-3 px-3 py-2.5 text-left"
              >
                <MessageSquare className="mt-0.5 size-4 shrink-0 text-ink-3" />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-ink">{c.title || "Untitled"}</span>
                  <span className="block text-xs text-ink-4">
                    {new Date(c.created_at).toLocaleString()}
                  </span>
                </span>
              </button>
              {confirmingId === c.id ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    void deleteConversation(c.id);
                  }}
                  className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-destructive hover:bg-destructive/10"
                >
                  Confirm
                </button>
              ) : (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirmingId(c.id);
                  }}
                  aria-label="Delete conversation"
                  className="shrink-0 rounded-md p-2 text-ink-4 opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                >
                  <Trash2 className="size-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </>
  );
}
