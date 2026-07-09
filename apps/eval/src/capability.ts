/**
 * Hemiunu capability suite — live, scenario-based evals that prove the agent
 * actually DOES the things that make it a product-team agent (not just that the
 * code compiles). Each scenario inspects the runTurn TurnEvent stream for an
 * OBJECTIVE signal — which tool was called, what landed in a file, whether a
 * fact was recalled — and falls back to an LLM judge only for genuinely
 * subjective quality (e.g. "is this wireframe grayscale and low-fi?").
 *
 *   corepack pnpm cap                        # run the whole suite (live; costs a few $)
 *   corepack pnpm cap S6 S8                  # run only those scenarios (id filter)
 *   corepack pnpm cap --model gemini-2.5-flash   # target any model registry entry
 *
 * Since P6-1c the suite drives the ENGINE runtime (createEngineRuntime →
 * TurnEvent), not the old SDK runtime — every scenario keeps its original
 * intent, asserted over tool-start/tool-result names, task events, and
 * turn-finish text/cost.
 *
 * Distinct from smoke.ts: smoke is the lean, mostly-offline pre-push gate; this
 * is the multi-turn, fixture-heavy capability proof (nightly / on demand).
 *
 * Isolation: every scenario runs in NO-TEAM/local mode (so nothing touches a real
 * GitHub repo) under a throwaway HEMIUNU_CONFIG_DIR, so memory / PROTOTYPE.md /
 * prototype writes — and the runtime's transcript db — land in a temp dir and
 * never pollute the user's ~/.hemiunu. The real Anthropic key/base URL are
 * copied into that temp dir first.
 */
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadConfig,
  configDir,
  createEngineRuntime,
  runEngineSubagent,
  SUBAGENTS,
  PARALLEL_TOOL_ID,
  type EngineRuntime,
  type EngineSubagentContext,
  type EngineTurnOptions,
} from "@hemiunu/agent-core";
import { emptyUsage, loadModelRegistry, type ResolvedModel, type TurnEvent } from "@hemiunu/engine";
import {
  check,
  report,
  collectTurnDetailed,
  calledTool,
  firstTool,
  judge,
  assert,
  parseEvalArgs,
  resolveEvalModel,
  type TurnDetail,
} from "./harness";

// ---- isolation + config (capture the REAL key before redirecting writes) ----
const real = loadConfig();
const REGISTRY = loadModelRegistry();
const ARGS = parseEvalArgs(process.argv.slice(2));
const MODEL = resolveEvalModel(ARGS.model ?? process.env.HEMIUNU_EVAL_MODEL, REGISTRY, real.model);
const RESEARCH = process.env.HEMIUNU_EVAL_RESEARCH ?? real.researchModel;
const JUDGE_MODEL = process.env.HEMIUNU_EVAL_JUDGE ?? real.model;

const SANDBOX = mkdtempSync(join(tmpdir(), "hemiunu-cap-"));
function setupSandbox() {
  // Seed the sandbox .env with the real credentials: loadConfig() already put
  // them in process.env (where the engine's resolveModel reads keys), and the
  // seed keeps any child process launched under HEMIUNU_CONFIG_DIR working.
  const env = [
    real.apiKey ? `ANTHROPIC_API_KEY=${real.apiKey}` : "",
    real.baseUrl ? `ANTHROPIC_BASE_URL=${real.baseUrl}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  writeFileSync(join(SANDBOX, ".env"), env + "\n");
  process.env.HEMIUNU_CONFIG_DIR = SANDBOX;
  process.env.HEMIUNU_NO_OPEN = "1"; // never spawn a browser in tests
}

// Optional id filter: `pnpm cap S6 S8` runs only those scenarios.
const ONLY = new Set(ARGS.rest.filter((a) => !a.startsWith("-")));
const want = (id: string) => ONLY.size === 0 || ONLY.has(id);

let liveCost = 0;
function track(d: TurnDetail): TurnDetail {
  liveCost += d.cost;
  return d;
}

let nonce = 0;
/** A unique local-session id (→ an isolated workspace dir under SANDBOX). */
function localSession(tag: string): string {
  return `cap-${tag}-${(nonce++).toString(36)}`;
}
function sessionDir(id: string): string {
  return join(configDir(), "tmp", "local", id);
}

/** Standard local-mode turn options for a scenario (no team, own workspace).
 *  `repo: ""` is the engine's no-team/local binding (agent-core maps it to
 *  a null repo + the local session workspace). */
function localTurn(
  id: string,
  opts: Partial<EngineTurnOptions> & { prompt: string },
): EngineTurnOptions {
  return {
    model: MODEL,
    researchModel: RESEARCH,
    workspace: { repo: "", localSessionId: id },
    ...opts,
  };
}

/**
 * Run a turn against a real filesystem MCP source built from `files`. The modern
 * @modelcontextprotocol/server-filesystem takes its allowed root from the SDK's
 * client roots (= process.cwd()), NOT from a CLI arg — so we chdir into the
 * fixture dir for the turn and restore cwd after. realpathSync avoids the macOS
 * /var → /private/var mismatch. The dir is also passed as an arg for forward-compat.
 * The MCP host is per-runtime, so the fixture server gets its own runtime.
 */
async function runGrounded(
  id: string,
  files: Record<string, string>,
  prompt: string,
): Promise<TurnDetail> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "hemiunu-src-")));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  const grounded = createEngineRuntime({
    dbPath: ":memory:", // grounded scenarios never resume — keep the sandbox db single-writer
    mcpServers: {
      filesystem: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-filesystem", dir],
      },
    },
  });
  const prevCwd = process.cwd();
  process.chdir(dir);
  try {
    return track(
      await collectTurnDetailed(grounded, {
        ...localTurn(id, { prompt }),
        toolPatterns: ["mcp__filesystem__*"],
      }),
    );
  } finally {
    process.chdir(prevCwd);
    await grounded.shutdown();
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  console.log("\n\x1b[1mHemiunu capability suite\x1b[0m");
  console.log(`\x1b[2mlive · model ${MODEL} · research ${RESEARCH}\x1b[0m\n`);
  setupSandbox();
  // The shared runtime for source-less scenarios: no MCP servers, transcript db
  // under the sandbox (so S11's resume finds its history).
  const rt: EngineRuntime = createEngineRuntime({ mcpServers: {} });

  // ---- S9: researcher runs on the cheaper tier (structural, free) ----
  if (want("S9"))
    await check("S9 researcher uses the research tier; prototyper the synthesis tier", async () => {
      assert(SUBAGENTS.researcher.tier === "research", "researcher must be on the research tier");
      assert(SUBAGENTS.prototyper.tier === "synthesis", "prototyper must be on the synthesis tier");
      // Engine-path proof: run each subagent on seams and record which registry
      // id the run resolves — the same resolution live delegations use.
      const resolved: string[] = [];
      const ctx: EngineSubagentContext = {
        registry: REGISTRY,
        model: MODEL,
        researchModel: RESEARCH,
        sourceTools: ["mcp__probe__*"], // the researcher needs connected sources
        resolve: (id) => {
          resolved.push(id);
          return {
            entry: REGISTRY.find((m) => m.id === id) ?? REGISTRY[0],
            languageModel: {} as ResolvedModel["languageModel"],
          };
        },
        runTurnImpl: async function* (): AsyncGenerator<TurnEvent> {
          yield {
            type: "turn-finish",
            text: "ok",
            usage: emptyUsage(),
            costUsd: 0,
            stopReason: "end",
          };
        },
      };
      await runEngineSubagent("researcher", "probe", ctx, { taskId: "s9-r" });
      await runEngineSubagent("prototyper", "probe", ctx, { taskId: "s9-p" });
      assert(resolved[0] === RESEARCH, "the research tier must resolve to researchModel");
      assert(resolved[1] === MODEL, "the synthesis tier must resolve to the main model");
    });

  // ---- S1: grounded answer from a connected source ----
  if (want("S1"))
    await check("S1 grounds an answer in a connected source", async () => {
      const d = await runGrounded(
        localSession("S1"),
        { "pricing.md": "# Pricing\n\nThe Pro tier launches at €14 per month.\n" },
        "Using ONLY the connected sources, what is the Pro tier launch price? Answer in one short sentence.",
      );
      assert(/€?\s?14\b/.test(d.text), `expected the €14 fact, got: ${d.text.slice(0, 120)}`);
      assert(
        d.delegations.includes("researcher") || calledTool(d, "filesystem"),
        "expected it to actually consult the source (researcher delegation or a filesystem read)",
      );
    });

  // ---- S2: admits ignorance instead of fabricating ----
  if (want("S2"))
    await check(
      "S2 admits ignorance when the source lacks the answer (no fabrication)",
      async () => {
        const d = await runGrounded(
          localSession("S2"),
          { "pricing.md": "# Pricing\n\nThe Pro tier launches at €14 per month.\n" },
          "Using ONLY the connected sources, what was our Q3 churn rate? If it isn't in the sources, say you don't know — do not guess a number.",
        );
        const admits =
          /don'?t know|do not know|not (in|found|available|present|specified|mentioned)|no (information|data|mention|figure)|couldn'?t find|isn'?t (in|covered|there)/i.test(
            d.text,
          );
        const fabricated = /\b\d+(\.\d+)?\s?%/.test(d.text);
        if (admits && !fabricated) return; // clean pass on the objective signal
        // Ambiguous → ask the judge for a fair verdict.
        const v = await judge<{ fabricated: boolean }>(rt, {
          model: JUDGE_MODEL,
          rubric:
            'Did this answer invent a specific Q3 churn rate that was NOT given to it? Reply {"fabricated": true|false}.',
          payload: d.text,
        });
        assert(!v.fabricated, `fabricated a churn figure: ${d.text.slice(0, 160)}`);
      },
    );

  // ---- S3: a user fact routes to remember (not PROTOTYPE.md) ----
  if (want("S3"))
    await check("S3 routes a USER fact to remember (not add_prototype_note)", async () => {
      const d = track(
        await collectTurnDetailed(
          rt,
          localTurn(localSession("S3"), {
            prompt:
              "Remember this about me: I'm the PM for the Growth squad and I prefer concise answers.",
          }),
        ),
      );
      assert(calledTool(d, "remember"), "expected the remember tool for a fact about the user");
      assert(
        !calledTool(d, "add_prototype_note"),
        "a user fact must NOT go into a feature's PROTOTYPE.md",
      );
    });

  // ---- S4: a feature fact routes to add_prototype_note (and lands in the file) ----
  if (want("S4"))
    await check(
      "S4 routes a FEATURE fact to add_prototype_note (lands in PROTOTYPE.md)",
      async () => {
        const id = localSession("S4");
        const d = track(
          await collectTurnDetailed(
            rt,
            localTurn(id, {
              prompt:
                "Record this decision for THIS feature: we'll use tabs instead of a wizard for the onboarding flow.",
            }),
          ),
        );
        assert(
          calledTool(d, "add_prototype_note"),
          "expected add_prototype_note for a feature decision",
        );
        assert(
          !calledTool(d, "remember"),
          "a feature fact must NOT go into the global user memory",
        );
        const file = join(sessionDir(id), "PROTOTYPE.md");
        assert(existsSync(file), "expected a local PROTOTYPE.md to be written");
        assert(/tabs/i.test(readFileSync(file, "utf8")), "the decision should be in PROTOTYPE.md");
      },
    );

  // ---- S5: mixed facts route correctly, no cross-contamination ----
  if (want("S5"))
    await check("S5 separates user vs feature facts with no cross-contamination", async () => {
      const d = track(
        await collectTurnDetailed(
          rt,
          localTurn(localSession("S5"), {
            prompt:
              "Two notes. (1) About me: I'm the PM for the Growth squad. (2) About this feature: we decided to use tabs instead of a wizard. Save each in the right place.",
          }),
        ),
      );
      const rem = firstTool(d, "remember");
      const note = firstTool(d, "add_prototype_note");
      assert(
        rem && /growth/i.test(String(rem.input.note ?? "")),
        "the user fact should go to remember",
      );
      assert(
        note && /tabs/i.test(String(note.input.text ?? "")),
        "the feature fact should go to add_prototype_note",
      );
      assert(
        !/tabs/i.test(String(rem?.input.note ?? "")),
        "the feature fact must NOT bleed into remember",
      );
      assert(
        !/growth/i.test(String(note?.input.text ?? "")),
        "the user fact must NOT bleed into PROTOTYPE.md",
      );
    });

  // ---- S6: self-contained grayscale low-fi wireframe (flagship) ----
  if (want("S6"))
    await check("S6 produces a self-contained low-fi wireframe", async () => {
      const id = localSession("S6");
      const d = track(
        await collectTurnDetailed(
          rt,
          localTurn(id, {
            prompt:
              "Mock up a low-fidelity wireframe for a newsletter signup screen: a headline, an email input, a Subscribe button, and a short privacy note. Low-fi, grayscale.",
          }),
        ),
      );
      assert(
        d.delegations.includes("prototyper") || calledTool(d, "save_prototype"),
        "expected the prototyper subagent / save_prototype",
      );
      const file = join(sessionDir(id), "index.html");
      assert(existsSync(file), "expected index.html flat in the workspace");
      const html = readFileSync(file, "utf8");
      assert(
        !/(?:src|href)\s*=\s*["']https?:\/\//i.test(html),
        "wireframe must not reference external URLs",
      );
      assert(!/<script[^>]+\bsrc=/i.test(html), "wireframe must not load external scripts");
      assert(
        !/@import\s+url\(\s*["']?https?:/i.test(html),
        "wireframe must not @import remote CSS",
      );
      assert(/<style[\s>]/i.test(html), "wireframe should carry inline CSS");
      assert(/subscribe|email/i.test(html), "wireframe should use the real labels from the brief");
      // Advisory quality judge — only fails on a clear miss.
      const v = await judge<{ grayscale: boolean; lowfi: boolean; score: number }>(rt, {
        model: JUDGE_MODEL,
        rubric:
          'Judge this HTML wireframe. Is it grayscale (no brand/saturated colors) and low-fidelity (structure/placeholders, not polished)? Reply {"grayscale": bool, "lowfi": bool, "score": 1-5}.',
        payload: html.slice(0, 6000),
      });
      console.log(
        `      \x1b[2mjudge: grayscale=${v.grayscale} lowfi=${v.lowfi} score=${v.score}/5\x1b[0m`,
      );
      assert(v.grayscale && v.lowfi, `judge rejected the wireframe (score ${v.score}/5)`);
    });

  // ---- S7: proactively logs a durable feature insight (unprompted) ----
  if (want("S7"))
    await check("S7 proactively records a durable feature insight to PROTOTYPE.md", async () => {
      const id = localSession("S7");
      const d = track(
        await collectTurnDetailed(
          rt,
          localTurn(id, {
            prompt:
              "Heads up — in the last 5 user interviews people kept missing the Save button because it's below the fold. Just sharing.",
          }),
        ),
      );
      assert(
        calledTool(d, "add_prototype_note"),
        "expected the agent to proactively capture the feedback in PROTOTYPE.md",
      );
    });

  // ---- S8: real parallel fan-out for independent subtasks ----
  // FINDING (model-dependent): Opus picks the `parallel` tool here; Sonnet tends
  // to do two SEQUENTIAL researcher delegations instead. Passes on the default
  // (Opus) model; a failure under --model/HEMIUNU_EVAL_MODEL=sonnet is that
  // known gap, not a regression.
  if (want("S8"))
    await check("S8 fans out independent subtasks via the parallel tool", async () => {
      const d = await runGrounded(
        localSession("S8"),
        {
          "ui.md": "The project uses an Ink terminal UI (React for the CLI).",
          "store.md": "Conversations are persisted in SQLite via node:sqlite.",
        },
        "Run these two INDEPENDENT research questions in parallel (at the same time, not one after the other), using the connected files, then report both: (A) which UI framework does the project use? (B) how are conversations stored?",
      );
      const par = firstTool(d, PARALLEL_TOOL_ID.split("__").pop()!); // "parallel"
      assert(
        par && Array.isArray(par.input.tasks) && par.input.tasks.length >= 2,
        "expected a parallel tool call with ≥2 independent tasks",
      );
      const starts = d.events.filter((e) => e.type === "task-start").length;
      assert(starts >= 2, `expected ≥2 concurrent task-start events, got ${starts}`);
    });

  // ---- S10: prototype-knowledge round-trip (get before update) ----
  if (want("S10"))
    await check(
      "S10 reads then rewrites PROTOTYPE.md (get_prototype before update_prototype)",
      async () => {
        const id = localSession("S10");
        const dir = sessionDir(id);
        mkdirSync(dir, { recursive: true });
        const seed =
          "---\nfeature: prototype\nupdated: 2020-01-01\n---\n\n" +
          "## Notes\n" +
          "- goal: let users export their dashboard to PDF\n" +
          "- primary user: ops managers who send weekly reports to execs\n" +
          "- research: 7/10 interviewees currently screenshot the dashboard by hand\n" +
          "- decision: export button lives in the dashboard top bar, not a settings page\n" +
          "- open question: do we need scheduled/recurring exports in v1?\n" +
          "- feedback: two users asked for branded headers on the PDF\n";
        writeFileSync(join(dir, "PROTOTYPE.md"), seed);
        const d = track(
          await collectTurnDetailed(
            rt,
            localTurn(id, {
              prompt:
                "Read this feature's PROTOTYPE.md and reorganize the accumulated notes into a clean, structured brief with sections (Goal, Primary user, Research, Decisions, Open questions). Then save the improved version.",
            }),
          ),
        );
        const gi = d.toolUses.findIndex((t) => t.name.includes("get_prototype"));
        const ui = d.toolUses.findIndex((t) => t.name.includes("update_prototype"));
        assert(gi >= 0, "expected get_prototype to be called");
        assert(ui >= 0, "expected update_prototype to be called");
        assert(gi < ui, "must read (get_prototype) BEFORE rewriting (update_prototype)");
        const after = readFileSync(join(dir, "PROTOTYPE.md"), "utf8");
        assert(after !== seed, "PROTOTYPE.md should have been rewritten");
      },
    );

  // ---- S11: conversation persists and resumes ----
  if (want("S11"))
    await check("S11 resumes a conversation and recalls earlier context", async () => {
      const id = localSession("S11");
      const t1 = track(
        await collectTurnDetailed(
          rt,
          localTurn(id, {
            prompt: "For this chat, note that my favorite product metric is activation rate.",
          }),
        ),
      );
      assert(t1.conversationId, "expected a conversation id from the first turn");
      const t2 = track(
        await collectTurnDetailed(
          rt,
          localTurn(id, {
            prompt: "What's my favorite product metric? Answer in one or two words.",
            resume: t1.conversationId,
          }),
        ),
      );
      assert(
        /activation/i.test(t2.text),
        `resume should recall the metric, got: ${t2.text.slice(0, 120)}`,
      );
    });

  console.log(`\n\x1b[2m  live turns cost ~$${liveCost.toFixed(4)}\x1b[0m`);
  await rt.shutdown();
}

main()
  .then(() => {
    rmSync(SANDBOX, { recursive: true, force: true });
    report();
  })
  .catch((err) => {
    rmSync(SANDBOX, { recursive: true, force: true });
    console.error("\n\x1b[31mcapability suite crashed:\x1b[0m", err);
    process.exit(1);
  });
