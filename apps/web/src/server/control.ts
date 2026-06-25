// Web-side control handler: gives the browser app CLI parity for team
// create/switch/rename. The agent's create_team/switch_team/rename_team tools
// (packages/agent-core/src/control.ts) emit a control event and wait for a
// registered handler — only the CLI registered one, so in the web app every
// such call returned "No interactive session is available to do that." We
// register one here that performs the same GitHub + persisted-state work as the
// CLI's handler (apps/cli/src/index.tsx:569-590), minus the React UI updates:
// the web has no footer to mutate — each turn re-reads the active team via
// turnRepo() -> currentTeam(), so updating persisted state is all that's needed.
import {
  addTeam,
  createRepo,
  currentTeam,
  githubViewer,
  migrateLocalIntoTeam,
  normalizeRepo,
  renameRepo,
  renameTeam,
  renameWorkspace,
  resolveGithubToken,
  setControlHandler,
  setCurrentTeam,
  switchTeam,
} from "@hemiunu/agent-core";

// Mirror of the CLI's createAndAdoptTeam (apps/cli/src/index.tsx:954).
async function createTeam(name: string): Promise<string> {
  const token = resolveGithubToken();
  if (!token) return "Not connected to GitHub — connect an account in the Teams panel first.";
  const r = await createRepo(token, name, { private: true });
  if ("error" in r) return `Couldn't create the repo: ${r.error}`;
  const repo = addTeam(r.repo);
  const login = (await githubViewer(token)) ?? undefined;
  const mig = await migrateLocalIntoTeam(repo, { token, login });
  setCurrentTeam(repo);
  return mig.migrated.length
    ? `Created ${repo} (private) and pushed your local work (${mig.migrated.join(", ")})${
        mig.pushed ? "" : ` — note: ${mig.note}`
      } — now your team.`
    : `Created ${repo} (private) — now your team.`;
}

// Switch into an existing team, carrying any local work into it first (matches
// the CLI handler's bringLocalWorkInto + adoptTeam).
async function switchToTeam(repo: string): Promise<string> {
  const ref = normalizeRepo(repo);
  if (!switchTeam(ref)) addTeam(ref); // not in the list yet — add + select
  const token = resolveGithubToken();
  if (token) {
    const login = (await githubViewer(token)) ?? undefined;
    await migrateLocalIntoTeam(ref, { token, login });
  }
  setCurrentTeam(ref);
  return `Now working in ${ref}.`;
}

// Mirror of the CLI's renameCurrentTeam (apps/cli/src/index.tsx:982).
async function renameCurrentTeam(name: string): Promise<string> {
  const current = currentTeam();
  if (!current)
    return "There's no team to rename — you're working locally. Create one first.";
  const token = resolveGithubToken();
  if (!token) return "Not connected to GitHub — connect an account in the Teams panel first.";
  const r = await renameRepo(token, current, name);
  if ("error" in r) {
    const taken = /\b422\b|already exists/i.test(r.error);
    return taken
      ? `Couldn't rename: you already have a repo called "${name}". Pick a different name.`
      : `Couldn't rename the repo: ${r.error}`;
  }
  const newRepo = r.repo;
  renameTeam(current, newRepo);
  await renameWorkspace(current, newRepo);
  setCurrentTeam(newRepo);
  return `Renamed the team to ${newRepo}. Your work carried over.`;
}

/**
 * Register the agent → server control bridge. Called once at server startup
 * (apps/web/src/server/index.ts). The handler is a process-global singleton in
 * agent-core; the web is single-user / local-first, so one registration at boot
 * is correct. Mid-turn create/switch mutates the global current team, but each
 * turn snapshots its repo via withWorkspace({ repo: turnRepo() }) at the start,
 * so the active turn keeps its repo and the next turn adopts the new one.
 */
export function registerControlHandler(): void {
  setControlHandler(async (e) => {
    switch (e.type) {
      case "create-team":
        return createTeam(e.name);
      case "switch-team":
        return switchToTeam(e.repo);
      case "rename-team":
        return renameCurrentTeam(e.name);
    }
  });
}
