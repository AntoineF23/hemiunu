import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { remember } from "@hemiunu/memory";
import { z } from "zod";

/** In-process MCP server exposing the `remember` tool to the agent. */
export function createMemoryServer() {
  const rememberTool = tool(
    "remember",
    "Save a durable note for future sessions. Use target 'user' for facts about the user, 'memory' for general product context, workflows, or facts.",
    { target: z.enum(["user", "memory"]), note: z.string() },
    async ({ target, note }) => {
      remember(target, note);
      return {
        content: [{ type: "text", text: `Saved to ${target}.md.` }],
      };
    },
    { annotations: { title: "Remember", readOnlyHint: false } },
  );

  return createSdkMcpServer({
    name: "hemiunu-memory",
    version: "0.0.0",
    tools: [rememberTool],
  });
}

/** Tool id the SDK exposes for the remember tool (server + tool name). */
export const REMEMBER_TOOL_ID = "mcp__hemiunu-memory__remember";
