import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { explainError } from "./explain";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter";
import {
  commitFile,
  getFile,
  githubViewer,
  repoExists,
  resolveGithubToken,
  resolveRepo,
} from "./github";
import { slugify } from "./prototype";
import { localWorkspaceDir } from "./workspace";

/**
 * A 404 from the Contents API is ambiguous: the FILE may be absent, OR the whole
 * repo may be unreachable by this token (wrong GitHub account / revoked access).
 * When something 404s, confirm the repo is actually reachable; if not, return
 * actionable guidance instead of pretending the file just needs creating — this
 * is the single most common confusing failure for a non-coder.
 */
async function repoAccessError(token: string, repo: string): Promise<string | null> {
  return (await repoExists(token, repo))
    ? null
    : `can't reach ${repo} — you may be signed in to a different GitHub account, or access was revoked. Reconnect with /github (or switch accounts), then try again.`;
}

/**
 * Team-knowledge layer. A team = a feature = a repo (1:1), so each repo carries
 * ONE living knowledge file — `PROTOTYPE.md` at the repo ROOT — holding the
 * feature's brief and memory (goal, primary user, sources, decisions, open
 * questions). This is the REMOTE path: it reads/commits that file straight
 * through the GitHub Contents API, so the agent maintains it WITHOUT cloning.
 */

/** The feature's knowledge file, at the repo root. */
export const PROTOTYPE_FILE = "PROTOTYPE.md";

export type NoteKind = "decision" | "question" | "feedback" | "note";

const SECTION: Record<NoteKind, string> = {
  decision: "Decisions",
  question: "Open questions",
  feedback: "Feedback",
  note: "Notes",
};

/** Path of the current feature's knowledge file (repo root). */
export function prototypePath(): string {
  return PROTOTYPE_FILE;
}

function titleize(name: string): string {
  const t = name
    .split(/[-_]/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
  return t || name;
}

/** Insert `bullet` at the end of the `## heading` section, creating it if absent. */
function appendUnderHeading(body: string, heading: string, bullet: string): string {
  const lines = body.length ? body.split("\n") : [];
  const hi = lines.findIndex((l) => l.trim() === heading);
  if (hi === -1) {
    const base = body.trim();
    return `${base ? `${base}\n\n` : ""}${heading}\n${bullet}`;
  }
  let end = lines.length;
  for (let i = hi + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
      end = i;
      break;
    }
  }
  while (end - 1 > hi && lines[end - 1].trim() === "") end--; // drop trailing blanks in section
  lines.splice(end, 0, bullet);
  return lines.join("\n");
}

/** Ensure/refresh the frontmatter for the feature's knowledge file. */
function withFrontmatter(
  existing: Record<string, string>,
  feature: string,
  date: string,
  body: string,
  authorAsOwner?: string,
): string {
  return renderFrontmatter(
    {
      title: existing.title || titleize(feature),
      feature: existing.feature || slugify(feature),
      owner: existing.owner || authorAsOwner,
      status: existing.status || "building",
      updated: date,
    },
    body,
  );
}

/**
 * Pure transform: append a knowledge entry to the feature's PROTOTYPE.md content
 * (or build it from scratch when `current` is null). Append-only, so concurrent
 * remote edits re-apply cleanly on retry.
 */
export function appendKnowledge(
  current: string | null,
  feature: string,
  kind: NoteKind,
  text: string,
  author: string,
  date: string,
): string {
  const parsed = current ? parseFrontmatter(current) : { meta: {}, body: "" };
  const bullet =
    kind === "question"
      ? `- [ ] ${text.trim()} (${author}, ${date})`
      : `- ${date} (${author}): ${text.trim()}`;
  const body = appendUnderHeading(parsed.body, `## ${SECTION[kind]}`, bullet);
  return withFrontmatter(parsed.meta, feature, date, body, author);
}

interface RemoteOpts {
  repo?: string;
  token?: string;
  branch?: string;
}

function todayISO(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function featureName(repo: string): string {
  return repo.split("/")[1] ?? repo;
}

// --- No-team (local) backend -------------------------------------------------
// With no team selected, knowledge is kept in a local PROTOTYPE.md in the launch
// folder, so work isn't lost; the agent suggests creating a team to push later.
function localPath(): string {
  return join(localWorkspaceDir(), PROTOTYPE_FILE);
}
function readLocal(): string | null {
  return existsSync(localPath()) ? readFileSync(localPath(), "utf8") : null;
}
// Agent-facing nudge: with no team, feature work isn't in a repo. Steer the
// agent to set one up ITSELF (create_team) rather than telling the user to run a
// manual command — most users don't think in "teams"/"repos". See soul.md.
const LOCAL_HINT =
  "It isn't saved to a repo yet. If the user is building a real feature (not a quick throwaway), set up a space for it yourself with create_team so the work persists — don't ask them to create one manually.";

/**
 * Append a note/decision/question/feedback to the current feature's PROTOTYPE.md.
 * With a team selected → commit to the repo root via the GitHub API (no clone);
 * with no team → write a local PROTOTYPE.md in the launch folder.
 */
export async function addPrototypeNote(
  kind: NoteKind,
  text: string,
  opts?: RemoteOpts,
): Promise<string> {
  const repo = opts?.repo ?? resolveRepo();
  const date = todayISO();
  if (!repo) {
    const next = appendKnowledge(readLocal(), "prototype", kind, text, "you", date);
    mkdirSync(localWorkspaceDir(), { recursive: true });
    writeFileSync(localPath(), next, "utf8");
    return `Saved ${kind} locally. ${LOCAL_HINT}`;
  }
  const token = opts?.token ?? resolveGithubToken();
  if (!token)
    return "Not signed in to GitHub — run /github, or switch to “no team” (Shift+Tab) to work locally.";
  try {
    const author = (await githubViewer(token)) ?? "unknown";
    const feature = featureName(repo);
    const { commitUrl } = await commitFile(
      token,
      repo,
      PROTOTYPE_FILE,
      (cur) => appendKnowledge(cur, feature, kind, text, author, date),
      `PROTOTYPE.md: add ${kind}`,
      opts?.branch,
    );
    return `Added ${kind} to ${repo}'s PROTOTYPE.md${commitUrl ? ` — ${commitUrl}` : ""}.`;
  } catch (e) {
    const access = await repoAccessError(token, repo);
    return `Couldn't update PROTOTYPE.md: ${access ?? explainError(e)}`;
  }
}

/** Read the current feature's PROTOTYPE.md (local with no team), or a message. */
export async function getPrototypeKnowledge(opts?: RemoteOpts): Promise<string> {
  const repo = opts?.repo ?? resolveRepo();
  if (!repo) {
    return (
      readLocal() ??
      `No PROTOTYPE.md here yet — it's created automatically the first time I save a note or decision. ${LOCAL_HINT}`
    );
  }
  const token = opts?.token ?? resolveGithubToken();
  if (!token) return "Not signed in to GitHub — run /github, or work locally with no team.";
  try {
    const file = await getFile(token, repo, PROTOTYPE_FILE, opts?.branch);
    if (!file) {
      // A 404 here might mean the repo itself is unreachable, not just an absent
      // file — distinguish so we don't promise a create that will then fail.
      const access = await repoAccessError(token, repo);
      return access
        ? `Couldn't read PROTOTYPE.md: ${access}`
        : `${repo} has no PROTOTYPE.md yet — it's created automatically the first time I save a note, decision, or update there. Nothing for you to do.`;
    }
    return file.content;
  } catch (e) {
    return `Couldn't read PROTOTYPE.md: ${explainError(e)}`;
  }
}

/**
 * Replace the feature's PROTOTYPE.md with an improved version (local with no
 * team). The caller passes the full Markdown body (frontmatter is managed); read
 * the current file first with getPrototypeKnowledge, then improve and rewrite.
 */
export async function updatePrototype(content: string, opts?: RemoteOpts): Promise<string> {
  const repo = opts?.repo ?? resolveRepo();
  const date = todayISO();
  const provided = parseFrontmatter(content); // tolerate content with or without frontmatter
  if (!repo) {
    const cur = readLocal();
    const meta = { ...(cur ? parseFrontmatter(cur).meta : {}), ...provided.meta };
    mkdirSync(localWorkspaceDir(), { recursive: true });
    writeFileSync(
      localPath(),
      withFrontmatter(meta, "prototype", date, provided.body || content.trim()),
      "utf8",
    );
    return `Updated the local PROTOTYPE.md. ${LOCAL_HINT}`;
  }
  const token = opts?.token ?? resolveGithubToken();
  if (!token) return "Not signed in to GitHub — run /github, or work locally with no team.";
  try {
    const author = (await githubViewer(token)) ?? undefined;
    const feature = featureName(repo);
    const { commitUrl } = await commitFile(
      token,
      repo,
      PROTOTYPE_FILE,
      (cur) => {
        const meta = { ...(cur ? parseFrontmatter(cur).meta : {}), ...provided.meta };
        return withFrontmatter(meta, feature, date, provided.body || content.trim(), author);
      },
      `PROTOTYPE.md: update`,
      opts?.branch,
    );
    return `Updated ${repo}'s PROTOTYPE.md${commitUrl ? ` — ${commitUrl}` : ""}.`;
  } catch (e) {
    const access = await repoAccessError(token, repo);
    return `Couldn't update PROTOTYPE.md: ${access ?? explainError(e)}`;
  }
}

/**
 * In-process MCP server: the agent maintains the current feature's PROTOTYPE.md
 * (repo root) remotely — no clone, attributed to the signed-in GitHub user. It
 * should keep this file current PROACTIVELY (see the persona), not on request.
 */
export function createPrototypeKnowledgeServer() {
  const addNoteTool = tool(
    "add_prototype_note",
    "Append a durable note to THIS feature's PROTOTYPE.md (at the root of the current team's repo). Use proactively, on your own, whenever you learn something durable about the feature — a research finding, a decision + rationale ('decision'), an open question ('question'), user/stakeholder feedback ('feedback'), or anything else ('note'). Saved to GitHub and attributed to the signed-in user. This file is managed only through these tools — never use the filesystem to find or edit it.",
    {
      kind: z.enum(["decision", "question", "feedback", "note"]).describe("Kind of entry."),
      text: z.string().describe("The note, in one clear line."),
    },
    async ({ kind, text }) => {
      const result = await addPrototypeNote(kind as NoteKind, text);
      return { content: [{ type: "text", text: result }] };
    },
    { annotations: { title: "Add prototype note", readOnlyHint: false } },
  );

  const getTool = tool(
    "get_prototype",
    "Read THIS feature's PROTOTYPE.md (repo root of the current team) — its goal, sources, decisions, open questions. Read it before improving it.",
    {},
    async () => {
      const result = await getPrototypeKnowledge();
      return { content: [{ type: "text", text: result }] };
    },
    { annotations: { title: "Get prototype", readOnlyHint: true } },
  );

  const updateTool = tool(
    "update_prototype",
    "Replace THIS feature's PROTOTYPE.md with an improved/restructured version (repo root). First read it with get_prototype, then pass the full improved Markdown body (frontmatter is handled for you). Use to organize accumulated knowledge into a clean brief.",
    {
      content: z.string().describe("The full improved PROTOTYPE.md body (Markdown sections)."),
    },
    async ({ content }) => {
      const result = await updatePrototype(content);
      return { content: [{ type: "text", text: result }] };
    },
    { annotations: { title: "Update prototype", readOnlyHint: false } },
  );

  return createSdkMcpServer({
    name: "hemiunu-prototype-knowledge",
    version: "0.0.0",
    tools: [addNoteTool, getTool, updateTool],
  });
}

/** Tool-availability wildcard for the prototype-knowledge server. */
export const PROTOTYPE_KNOWLEDGE_TOOLS = "mcp__hemiunu-prototype-knowledge__*";
