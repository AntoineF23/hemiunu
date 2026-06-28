import { useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { sendJSON } from "@/lib/api";
import { MODELS, type Settings } from "../../useSettings";

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: Settings | null;
  onChanged: () => void;
  onModelChange: (id: string) => void;
}

export function SettingsPanel({
  open,
  onOpenChange,
  settings,
  onChanged,
  onModelChange,
}: SettingsPanelProps) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<string | null>(null);

  const saveKey = async () => {
    if (!key.trim()) return;
    setBusy(true);
    try {
      await sendJSON("/api/settings/anthropic-key", { key: key.trim() });
      setKey("");
      setFlash("API key saved.");
      onChanged();
    } catch {
      setFlash("Could not save the key.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <SheetHeader>
        <SheetTitle>Settings</SheetTitle>
        <SheetDescription>Model, credentials, and connection status.</SheetDescription>
      </SheetHeader>

        <div className="flex flex-col gap-5 py-1">
          {/* Model */}
          <div className="flex flex-col gap-2">
            <Label>Brain model</Label>
            <Select value={settings?.model} onValueChange={onModelChange}>
              <SelectTrigger>
                <SelectValue placeholder="Select a model" />
              </SelectTrigger>
              <SelectContent>
                {MODELS.map((m) => (
                  <SelectItem key={m.id} value={m.id}>
                    {m.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* API key */}
          <div className="flex flex-col gap-2">
            <Label htmlFor="api-key">
              Anthropic API key {settings?.hasApiKey && <Badge>configured</Badge>}
            </Label>
            <div className="flex gap-2">
              <Input
                id="api-key"
                type="password"
                placeholder={settings?.hasApiKey ? "•••• replace key" : "sk-ant-…"}
                value={key}
                onChange={(e) => setKey(e.target.value)}
              />
              <Button onClick={saveKey} disabled={busy || !key.trim()}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : "Save"}
              </Button>
            </div>
            {flash && <p className="text-xs text-ink-3">{flash}</p>}
          </div>

          {/* Status */}
          <div className="flex flex-col gap-2">
            <Label>Connections</Label>
            <div className="flex flex-wrap gap-2">
              <StatusChip label="GitHub" on={!!settings?.github} />
              <StatusChip label="Vercel" on={!!settings?.vercel} />
            </div>
            {settings?.mcpServers?.length ? (
              <div className="mt-1">
                <p className="mb-1.5 text-xs text-ink-3">MCP servers</p>
                <div className="flex flex-wrap gap-1.5">
                  {settings.mcpServers.map((s) => (
                    <Badge key={s} variant="secondary">
                      {s}
                    </Badge>
                  ))}
                  {settings.mcpSkipped?.map((s) => (
                    <Badge key={s.name} variant="outline" title={s.reason || "skipped"}>
                      {s.name} (off)
                    </Badge>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
        </div>
    </>
  );
}

function StatusChip({ label, on }: { label: string; on: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-border px-2.5 py-1 text-xs text-ink-2">
      {on ? <Check className="size-3.5 text-oasis" /> : <X className="size-3.5 text-ink-4" />}
      {label}
    </span>
  );
}
