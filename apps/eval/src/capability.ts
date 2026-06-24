/**
 * Hemiunu capability suite — live, scenario-based evals that prove the agent
 * actually DOES the things that make it a product-team agent (not just that the
 * code compiles). Each scenario inspects the runTurn message stream for an
 * objective signal — which tool was called, what landed in a file, whether a
 * fact was recalled — and falls back to an LLM judge only for genuinely
 * subjective quality (e.g. "is this wireframe grayscale and low-fi?").
 *
 *   corepack pnpm cap            # run the whole suite (live; costs a few $)
 *   corepack pnpm cap S6         # run one scenario by id (filter)
 *
 * Distinct from smoke.ts: smoke is the lean, mostly-offline pre-push gate;
 * this is the multi-turn, fixture-heavy capability proof (nightly / on demand).
 */
import { loadConfig } from "@hemiunu/agent-core";
import { check, report } from "./harness";

const MODEL = process.env.HEMIUNU_EVAL_MODEL ?? loadConfig().model;
// Optional id filter: `pnpm cap S6 S8` runs only those scenarios.
const ONLY = new Set(process.argv.slice(2).filter((a) => !a.startsWith("-")));
const want = (id: string) => ONLY.size === 0 || ONLY.has(id);

async function main() {
  console.log("\n\x1b[1mHemiunu capability suite\x1b[0m");
  console.log(`\x1b[2mlive · model ${MODEL}\x1b[0m\n`);

  // Scenarios S1–S11 land in Slice 2.
  void check;
  void want;

  report();
}

main().catch((err) => {
  console.error("\n\x1b[31mcapability suite crashed:\x1b[0m", err);
  process.exit(1);
});
