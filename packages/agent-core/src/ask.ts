/**
 * The `ask_user` tool ids — the agent's only way to ask the user a structured,
 * multiple-choice question and block until they answer. The tool itself is the
 * HemiTool in hemitools/ask.ts (over the agent→front-end control bridge, see
 * control.ts): it emits an `ask-user` event, the CLI/web render a chooser, and
 * the chosen answer comes back as the tool result.
 *
 * Use sparingly — only when genuinely blocked on a user DECISION; otherwise make
 * a reasonable assumption and note it (see the persona).
 */

/** Resolved id of the ask_user tool — auto-approved by the front-ends (asking
 *  the user is the whole point; it must never sit behind a "may I ask?" prompt). */
export const ASK_USER_TOOL_ID = "mcp__hemiunu-ask__ask_user";
