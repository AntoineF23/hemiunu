import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Github, Loader2, Plus, Trash2 } from "lucide-react";
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
import { getJSON, sendJSON } from "@/lib/api";
import { cn } from "@/lib/utils";

interface TeamsData {
  teams: string[];
  current: string | null;
  github: boolean;
}

interface DeviceInfo {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface TeamsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}

export function TeamsPanel({ open, onOpenChange, onChanged }: TeamsPanelProps) {
  const [data, setData] = useState<TeamsData | null>(null);
  const [addRef, setAddRef] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const pollAlive = useRef(false);

  const load = useCallback(async () => {
    try {
      setData(await getJSON<TeamsData>("/api/teams"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    if (open) {
      setError(null);
      void load();
    } else {
      pollAlive.current = false; // stop any in-flight GitHub poll when closed
      setDevice(null);
      setConnecting(false);
    }
  }, [open, load]);

  const run = async (fn: () => Promise<TeamsData>) => {
    setBusy(true);
    setError(null);
    try {
      setData(await fn());
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const switchTo = (repo: string | null) =>
    run(() => sendJSON<TeamsData>("/api/teams/switch", { repo }));
  const remove = (ref: string) => run(() => sendJSON<TeamsData>("/api/teams/remove", { ref }));
  const add = () =>
    addRef.trim() &&
    run(async () => {
      const d = await sendJSON<TeamsData>("/api/teams/add", { ref: addRef.trim() });
      setAddRef("");
      return d;
    });
  const create = () =>
    newName.trim() &&
    run(async () => {
      const d = await sendJSON<TeamsData>("/api/teams/create", { name: newName.trim() });
      setNewName("");
      return d;
    });

  const connectGithub = async () => {
    setError(null);
    setConnecting(true);
    try {
      const dev = await sendJSON<DeviceInfo>("/api/github/auth/start", {});
      setDevice(dev);
      window.open(dev.verificationUri, "_blank", "noopener");
      pollAlive.current = true;
      // Poll until authorized, denied, or the panel closes.
      for (;;) {
        if (!pollAlive.current) return;
        await sleep((dev.interval || 5) * 1000);
        const res = await sendJSON<{ status: string; message?: string; interval?: number }>(
          "/api/github/auth/poll",
          { deviceCode: dev.deviceCode },
        );
        if (res.status === "authorized") break;
        if (res.status === "error") throw new Error(res.message ?? "authorization failed");
      }
      setDevice(null);
      await load();
      onChanged();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConnecting(false);
    }
  };

  const current = data?.current ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="left" className="w-full max-w-md gap-5 overflow-y-auto">
        <SheetHeader>
          <SheetTitle>Teams</SheetTitle>
          <SheetDescription>
            A team is one prototype repo. Switch the active team, add an existing repo, or create a
            new one.
          </SheetDescription>
        </SheetHeader>

        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {/* Selection list */}
        <div className="flex flex-col gap-1">
          <TeamRow
            label="Local workspace"
            hint="No repo — work locally"
            active={!current}
            onSelect={() => switchTo(null)}
            disabled={busy}
          />
          {data?.teams.map((repo) => (
            <TeamRow
              key={repo}
              label={repo}
              active={current === repo}
              onSelect={() => switchTo(repo)}
              onRemove={() => remove(repo)}
              disabled={busy}
            />
          ))}
        </div>

        {/* Add existing */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="add-repo">Add an existing repo</Label>
          <div className="flex gap-2">
            <Input
              id="add-repo"
              placeholder="owner/name"
              value={addRef}
              onChange={(e) => setAddRef(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && add()}
            />
            <Button variant="secondary" onClick={add} disabled={busy || !addRef.trim()}>
              Add
            </Button>
          </div>
        </div>

        {/* Create new */}
        <div className="flex flex-col gap-2">
          <Label htmlFor="new-repo">Create a new repo</Label>
          <div className="flex gap-2">
            <Input
              id="new-repo"
              placeholder="my-feature"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && create()}
              disabled={!data?.github}
            />
            <Button onClick={create} disabled={busy || !data?.github || !newName.trim()}>
              <Plus className="size-4" />
              Create
            </Button>
          </div>
        </div>

        {/* GitHub connection */}
        <div className="mt-1 rounded-lg border border-border p-3">
          {data?.github ? (
            <p className="flex items-center gap-2 text-sm text-ink-2">
              <Check className="size-4 text-sage" />
              Connected to GitHub
            </p>
          ) : device ? (
            <div className="flex flex-col gap-2 text-sm">
              <p className="text-ink-2">Enter this code at the GitHub page that opened:</p>
              <code className="self-start rounded-md bg-raised px-3 py-1.5 font-mono text-base tracking-widest text-ink">
                {device.userCode}
              </code>
              <a
                href={device.verificationUri}
                target="_blank"
                rel="noreferrer noopener"
                className="inline-flex items-center gap-1 text-clay-strong hover:underline"
              >
                Open github.com/login/device <ExternalLink className="size-3.5" />
              </a>
              <p className="flex items-center gap-2 text-ink-3">
                <Loader2 className="size-3.5 animate-spin" /> Waiting for authorization…
              </p>
            </div>
          ) : (
            <Button variant="secondary" onClick={connectGithub} disabled={connecting}>
              {connecting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Github className="size-4" />
              )}
              Connect GitHub
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

interface TeamRowProps {
  label: string;
  hint?: string;
  active: boolean;
  onSelect: () => void;
  onRemove?: () => void;
  disabled?: boolean;
}

function TeamRow({ label, hint, active, onSelect, onRemove, disabled }: TeamRowProps) {
  return (
    <div
      className={cn(
        "group flex items-center gap-2 rounded-lg border px-3 py-2.5 transition-colors",
        active ? "border-clay/40 bg-clay-soft" : "border-border hover:bg-accent",
      )}
    >
      <button
        onClick={onSelect}
        disabled={disabled}
        className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
      >
        <span
          className={cn(
            "grid size-4 shrink-0 place-items-center rounded-full border",
            active ? "border-clay bg-clay text-primary-foreground" : "border-ink-4",
          )}
        >
          {active && <Check className="size-3" strokeWidth={3} />}
        </span>
        <span className="min-w-0">
          <span className="block truncate text-sm text-ink">{label}</span>
          {hint && <span className="block text-xs text-ink-4">{hint}</span>}
        </span>
      </button>
      {onRemove && (
        <button
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove ${label}`}
          className="shrink-0 rounded p-1 text-ink-4 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
        >
          <Trash2 className="size-4" />
        </button>
      )}
    </div>
  );
}
