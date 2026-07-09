// The HemiTool ports of Hemiunu's 11 in-process tool servers, plus the
// assembler that builds the full engine tool set for a turn. Names keep the
// old `mcp__<server>__<tool>` ids so toolpolicy, allowlists, and evals keep
// pattern-matching them unchanged.

import type { HemiTool } from "@hemiunu/engine";
import { controlTools } from "@hemiunu/engine";
import { createDelegateTool, type EngineSubagentContext } from "../engine-subagents";
import { createAskTools } from "./ask";
import { createMemoryTools } from "./memory";
import { createModelsTools } from "./models";
import { createOrchestratorTools } from "./orchestrator";
import { createPrototypeTools } from "./prototype";
import { createPrototypeKnowledgeTools } from "./prototype-knowledge";
import { createShareTools } from "./share";
import { createSkillsTools } from "./skills";
import { createSourcesTools } from "./sources";
import { createTeamControlTools } from "./team-control";
import { createWorkspaceTools } from "./workspace";

export { defineTool, ok } from "./helpers";
export { createAskTools } from "./ask";
export { createMemoryTools } from "./memory";
export { createModelsTools } from "./models";
export { createOrchestratorTools } from "./orchestrator";
export { createPrototypeTools } from "./prototype";
export { createPrototypeKnowledgeTools } from "./prototype-knowledge";
export { createShareTools } from "./share";
export { createSkillsTools } from "./skills";
export { createSourcesTools } from "./sources";
export { createTeamControlTools } from "./team-control";
export { createWorkspaceTools } from "./workspace";

export interface HemiToolsOptions {
  /** Subagent context — required for `delegate` and the orchestrator's
   *  `parallel`; omit it (e.g. inside a subagent — recursion depth 1) and both
   *  are left out. */
  subagentCtx?: EngineSubagentContext;
  /** Per-user config root override (tests). */
  userRoot?: string;
}

/**
 * Every in-process HemiTool for a turn: the 11 ported servers plus the
 * engine-owned control tools (todo_write, enter_plan_mode, exit_plan_mode),
 * and — for the MAIN turn only — the delegation surface (`delegate` +
 * `parallel`). Subagents fan out from `base`, which never contains either,
 * so a subagent cannot delegate further.
 */
export function allHemiTools(opts: HemiToolsOptions = {}): HemiTool[] {
  const base: HemiTool[] = [
    ...createMemoryTools(opts.userRoot),
    ...createModelsTools(),
    ...createAskTools(),
    ...createTeamControlTools(),
    ...createPrototypeTools(),
    ...createShareTools(),
    ...createWorkspaceTools(),
    ...createSourcesTools(opts.userRoot),
    ...createSkillsTools(opts.userRoot),
    ...createPrototypeKnowledgeTools(),
    ...controlTools(),
  ];
  if (!opts.subagentCtx) return base;
  // Subagent runs pick their tools from `base` (delegate/parallel excluded by
  // construction — and filtered defensively in engine-subagents).
  const ctx: EngineSubagentContext = {
    userRoot: opts.userRoot,
    ...opts.subagentCtx,
    tools: opts.subagentCtx.tools ?? base,
  };
  return [...base, ...createOrchestratorTools(ctx), createDelegateTool(ctx)];
}
