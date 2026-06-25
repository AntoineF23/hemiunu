import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ExternalLink, Github, Loader2, Plus, Trash2, UserPlus } from "lucide-react";
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
import { Avatar } from "../Avatar";

interface TeamsData {
  teams: string[];
  current: string | null;
  github: boolean;
  /** Active GitHub account login (teams are scoped to it), or null. */
  account: string | null;
  /** All connected account logins, for the switcher. */
  accounts: string[];
}

interface DeviceInfo {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
}

interface Teammate {
  login: string;
  admin: boolean;
  push: boolean;
}
interface TeammatesData {
  repo: string | null;
  github: boolean;
  /** Whether the signed-in user can remove collaborators (repo owner/admin). */
  admin: boolean;
  teammates: Teammate[];
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
  const [tm, setTm] = useState<TeammatesData | null>(null);
  const [tmInput, setTmInput] = useState("");
  const [tmFlash, setTmFlash] = useState<string | null>(null);
  const [tmBusy, setTmBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setData(await getJSON<TeamsData>("/api/teams"));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadTeammates = useCallback(async () => {
    try {
      setTm(await getJSON<TeammatesData>("/api/teammates"));
    } catch {
      /* leave previous list */
    }
  }, []);

  // (Re)load teammates whenever the panel opens or the active team changes.
  useEffect(() => {
    if (open) void loadTeammates();
  }, [open, data?.current, loadTeammates]);

  useEffect(() => {
    if (open) {
      setError(null);
      setTmFlash(null);
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

  const inviteTeammate = async () => {
    const name = tmInput.trim();
    if (!name) return;
    setTmBusy(true);
    setTmFlash(null);
    try {
      const { message } = await sendJSON<{ message: string }>("/api/teammates", { username: name });
      setTmFlash(message);
      setTmInput("");
      await loadTeammates();
    } catch (e) {
      setTmFlash(e instanceof Error ? e.message : String(e));
    } finally {
      setTmBusy(false);
    }
  };

  const removeTeammate = async (login: string) => {
    setTmBusy(true);
    setTmFlash(null);
    try {
      const res = await fetch(`/api/teammates/${encodeURIComponent(login)}`, { method: "DELETE" });
      const { message } = (await res.json()) as { message?: string };
      if (message) setTmFlash(message);
      await loadTeammates();
    } catch (e) {
      setTmFlash(e instanceof Error ? e.message : String(e));
    } finally {
      setTmBusy(false);
    }
  };

  const switchAccount = (login: string) =>
    run(async () => {
      const d = await sendJSON<TeamsData>("/api/github/switch", { login });
      await loadTeammates();
      onChanged();
      return d;
    });

  const disconnect = () =>
    run(async () => {
      const d = await sendJSON<TeamsData>("/api/github/disconnect", {});
      onChanged();
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
            Teams belong to a GitHub account. Switch profile to see that account's teams.
          </SheetDescription>
        </SheetHeader>

        {error && (
          <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </p>
        )}

        {/* GitHub account — teams below are scoped to the active one */}
        <div className="flex flex-col gap-2">
          <Label>GitHub account</Label>
          <div className="flex flex-col gap-1">
            {data && !data.accounts.length && (
              <p className="px-1 text-sm text-ink-3">No GitHub account connected yet.</p>
            )}
            {data?.accounts.map((login) => {
              const active = login === data.account;
              return (
                <button
                  key={login}
                  onClick={() => !active && switchAccount(login)}
                  disabled={busy}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors",
                    active ? "border-clay/40 bg-clay-soft" : "border-border hover:bg-accent",
                  )}
                >
                  <Avatar
                    login={login}
                    fallback={login.charAt(0).toUpperCase()}
                    className="size-7 rounded-full bg-raised text-xs font-semibold text-ink-2"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{login}</span>
                    {active && <span className="block text-xs text-ink-4">active</span>}
                  </span>
                  {active ? (
                    <Check className="size-4 shrink-0 text-clay" />
                  ) : (
                    <span className="shrink-0 text-xs text-ink-4">switch</span>
                  )}
                </button>
              );
            })}
          </div>

          {device ? (
            <div className="flex flex-col gap-2 rounded-lg border border-border p-3 text-sm">
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
            <div className="flex gap-2">
              <Button variant="secondary" onClick={connectGithub} disabled={connecting}>
                {connecting ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : (
                  <Github className="size-4" />
                )}
                Connect {data?.accounts.length ? "another account" : "GitHub"}
              </Button>
              {data?.github && (
                <Button variant="ghost" onClick={disconnect} disabled={busy}>
                  Disconnect
                </Button>
              )}
            </div>
          )}
        </div>

        {/* Teams for the active account */}
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

        {/* Teammates on the current team's repo */}
        {current && (
          <div className="flex flex-col gap-2">
            <Label>Teammates</Label>
            {!data?.github ? (
              <p className="text-xs text-ink-4">Connect GitHub to manage teammates.</p>
            ) : (
              <>
                <div className="flex flex-col gap-1">
                  {tm?.teammates.length === 0 && (
                    <p className="px-1 text-sm text-ink-3">No collaborators yet.</p>
                  )}
                  {tm?.teammates.map((m) => (
                    <div
                      key={m.login}
                      className="group flex items-center gap-2.5 rounded-lg border border-border px-3 py-2"
                    >
                      <Avatar
                        login={m.login}
                        fallback={m.login.charAt(0).toUpperCase()}
                        className="size-7 rounded-full bg-raised text-xs font-semibold text-ink-2"
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-ink">{m.login}</span>
                      <span className="shrink-0 text-xs text-ink-4">
                        {m.admin ? "admin" : m.push ? "write" : "read"}
                      </span>
                      {tm?.admin && (
                        <button
                          onClick={() => removeTeammate(m.login)}
                          disabled={tmBusy}
                          aria-label={`Remove ${m.login}`}
                          className="shrink-0 rounded p-1 text-ink-4 opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100"
                        >
                          <Trash2 className="size-4" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <Input
                    placeholder="github-username"
                    value={tmInput}
                    onChange={(e) => setTmInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && inviteTeammate()}
                  />
                  <Button
                    variant="secondary"
                    onClick={inviteTeammate}
                    disabled={tmBusy || !tmInput.trim()}
                  >
                    {tmBusy ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <UserPlus className="size-4" />
                    )}
                    Invite
                  </Button>
                </div>
                {tmFlash && <p className="text-xs text-ink-3">{tmFlash}</p>}
              </>
            )}
          </div>
        )}
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
