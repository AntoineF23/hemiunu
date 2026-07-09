// Inventory guard for the HemiTool ports: all 11 servers present, every tool
// keeping its exact `mcp__<server>__<tool>` id (toolpolicy, allowlists, and
// the evals pattern-match those names), plus the engine-owned control tools.

import assert from "node:assert/strict";
import { test } from "node:test";
import type { EngineSubagentContext } from "../engine-subagents";
import { allHemiTools } from "./index";

const subagentCtx: EngineSubagentContext = {
  model: "test-model",
  researchModel: "test-research",
  sourceTools: [],
};

const EXPECTED = [
  "mcp__hemiunu-memory__remember",
  "mcp__hemiunu-models__ask_model",
  "mcp__hemiunu-ask__ask_user",
  "mcp__hemiunu-team-control__create_team",
  "mcp__hemiunu-team-control__switch_team",
  "mcp__hemiunu-team-control__list_teams",
  "mcp__hemiunu-team-control__rename_team",
  "mcp__hemiunu-team-control__add_teammate",
  "mcp__hemiunu-team-control__remove_teammate",
  "mcp__hemiunu-orchestrator__parallel",
  "mcp__hemiunu-prototype__save_prototype",
  "mcp__hemiunu-share__commit_prototype",
  "mcp__hemiunu-share__deploy_prototype",
  "mcp__hemiunu-workspace__iterate_prototype",
  "mcp__hemiunu-workspace__list_workspace_files",
  "mcp__hemiunu-workspace__read_workspace_file",
  "mcp__hemiunu-workspace__search_workspace",
  "mcp__hemiunu-workspace__write_workspace_file",
  "mcp__hemiunu-workspace__check_prototype",
  "mcp__hemiunu-sources__save_source_map",
  "mcp__hemiunu-sources__get_source_map",
  "mcp__hemiunu-skills__save_skill",
  "mcp__hemiunu-skills__list_skills",
  "mcp__hemiunu-skills__get_skill",
  "mcp__hemiunu-prototype-knowledge__add_prototype_note",
  "mcp__hemiunu-prototype-knowledge__get_prototype",
  "mcp__hemiunu-prototype-knowledge__update_prototype",
  // Engine-owned control tools (replace the SDK's TodoWrite/Enter/ExitPlanMode).
  "todo_write",
  "enter_plan_mode",
  "exit_plan_mode",
  // Engine-loop delegation (P4) — the Task replacement, main turn only.
  "delegate",
];

test("hemitools: all 11 servers ported, ids exactly preserved, no duplicates", () => {
  const tools = allHemiTools({ subagentCtx });
  const names = tools.map((t) => t.name);
  assert.deepEqual(names.sort(), [...EXPECTED].sort());
  assert.equal(new Set(names).size, names.length, "tool names must be unique");
  const servers = new Set(
    names.filter((n) => n.startsWith("mcp__")).map((n) => n.slice(5).split("__")[0]),
  );
  assert.equal(servers.size, 11, "exactly the 11 in-process servers");
});

test("hemitools: delegation tools are only offered when a subagent context exists", () => {
  const names = allHemiTools().map((t) => t.name);
  assert.ok(!names.includes("mcp__hemiunu-orchestrator__parallel"));
  assert.ok(!names.includes("delegate"));
});

test("hemitools: permissions match the old front-end auto-approvals", () => {
  const tools = allHemiTools({ subagentCtx });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const auto = tools.filter((t) => t.permission === "auto").map((t) => t.name);
  assert.deepEqual(auto.sort(), [
    "enter_plan_mode",
    "mcp__hemiunu-ask__ask_user",
    "mcp__hemiunu-memory__remember",
    "mcp__hemiunu-sources__get_source_map",
    "mcp__hemiunu-sources__save_source_map",
    "todo_write",
  ]);
  // Read-only marks (what plan mode keeps available).
  for (const name of [
    "mcp__hemiunu-workspace__list_workspace_files",
    "mcp__hemiunu-workspace__read_workspace_file",
    "mcp__hemiunu-workspace__search_workspace",
    "mcp__hemiunu-workspace__check_prototype",
    "mcp__hemiunu-models__ask_model",
    "mcp__hemiunu-prototype-knowledge__get_prototype",
    "exit_plan_mode",
  ]) {
    assert.equal(byName.get(name)?.readOnly, true, `${name} should be readOnly`);
  }
  for (const name of [
    "mcp__hemiunu-workspace__write_workspace_file",
    "mcp__hemiunu-prototype__save_prototype",
    "mcp__hemiunu-share__commit_prototype",
  ]) {
    assert.equal(byName.get(name)?.readOnly ?? false, false, `${name} must not be readOnly`);
  }
});
