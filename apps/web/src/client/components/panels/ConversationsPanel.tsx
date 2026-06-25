import { useCallback, useEffect, useState } from "react";
import { Loader2, MessageSquare } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { getJSON } from "@/lib/api";

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
}

export function ConversationsPanel({ open, onOpenChange, onResume }: ConversationsPanelProps) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-full max-w-md gap-4 overflow-y-auto">
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
              <button
                key={c.id}
                onClick={() => openConversation(c.id)}
                className="flex items-start gap-3 rounded-lg border border-transparent px-3 py-2.5 text-left transition-colors hover:border-border hover:bg-accent"
              >
                <MessageSquare className="mt-0.5 size-4 shrink-0 text-ink-3" />
                <span className="min-w-0">
                  <span className="block truncate text-sm text-ink">{c.title || "Untitled"}</span>
                  <span className="block text-xs text-ink-4">
                    {new Date(c.created_at).toLocaleString()}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
