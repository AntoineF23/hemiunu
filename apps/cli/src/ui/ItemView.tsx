import { prettyTool } from "@hemiunu/format";
import { Box, Text } from "ink";
import type { Item } from "../types";
import { Banner } from "./Banner";
import { md } from "./markdown";
import { SAGE, SAND } from "./theme";

export function ItemView({ item }: { item: Item }) {
  switch (item.kind) {
    case "banner":
      return <Banner />;
    case "user":
      return (
        <Box marginTop={1}>
          <Text>
            <Text color={SAND} bold>
              {"› "}
            </Text>
            {item.text}
          </Text>
        </Box>
      );
    case "text":
      // A subagent's own narration — what it's looking for / what it found.
      // This is the meaningful explanation, so keep it readable (NOT dimmed,
      // unlike the surrounding tool lines); a sage marker + indent ties it to
      // the delegation while still standing apart from the main agent's answer.
      if (item.sub)
        return (
          <Box marginLeft={2}>
            <Text wrap="wrap">
              <Text color={SAGE} bold>
                {"› "}
              </Text>
              {item.text}
            </Text>
          </Box>
        );
      return (
        <Box marginTop={1}>
          <Text>
            <Text color={SAGE} bold>
              {"⏺ "}
            </Text>
            {md(item.text)}
          </Text>
        </Box>
      );
    case "tool":
      // Delegation to a subagent — distinct glyph + the researcher's tier.
      if (item.delegate)
        return (
          <Box marginTop={1}>
            <Text>
              <Text color={SAND} bold>
                {"⌂ "}
              </Text>
              <Text color={SAND} bold>
                {prettyTool(item.name)}
              </Text>
              <Text dimColor>{` ${item.input}`}</Text>
            </Text>
          </Box>
        );
      // A tool the researcher ran — indented under the delegation, dimmer.
      if (item.sub)
        return (
          <Text dimColor>
            {"    ⌕ "}
            <Text color={SAGE}>{prettyTool(item.name)}</Text>
            {` ${item.input}`}
          </Text>
        );
      return (
        <Box marginTop={1}>
          <Text>
            <Text color={SAGE} bold>
              {"⏺ "}
            </Text>
            <Text color={SAND} bold>
              {prettyTool(item.name)}
            </Text>
            <Text dimColor>{` ${item.input}`}</Text>
          </Text>
        </Box>
      );
    case "group":
      // A coalesced activity run, committed as one summary line.
      return (
        <Box marginTop={1}>
          <Text>
            <Text color={item.delegate ? SAND : SAGE} bold>
              {item.delegate ? "⌂ " : "⏺ "}
            </Text>
            <Text dimColor>{item.text}</Text>
          </Text>
        </Box>
      );
    case "result":
      return <Text dimColor>{`${item.sub ? "      " : "  "}⎿ ${item.text}`}</Text>;
    case "answer": {
      // The subagent's full answer, printed under its delegation. A sand header
      // names the specialist; the body is indented and markdown-rendered so the
      // findings read cleanly, set apart from the main agent's own reply.
      const who = `${item.agent.charAt(0).toUpperCase()}${item.agent.slice(1)}`;
      return (
        <Box marginTop={1} marginLeft={2} flexDirection="column">
          <Text>
            <Text color={SAND} bold>
              {"⌂ "}
            </Text>
            <Text color={SAND} bold>
              {`${who}'s answer`}
            </Text>
          </Text>
          <Box marginLeft={2}>
            <Text wrap="wrap">{md(item.text)}</Text>
          </Box>
        </Box>
      );
    }
    case "perm":
      return (
        <Text>
          {"  "}
          <Text color={item.ok ? SAGE : SAND}>{item.ok ? "✓" : "✗"}</Text>
          <Text dimColor>{` ${item.text}`}</Text>
        </Text>
      );
    case "cost":
      return <Text dimColor>{`  ${item.text}`}</Text>;
    case "note":
      return (
        <Box marginTop={1}>
          <Text color={SAND}>{item.text}</Text>
        </Box>
      );
    case "error":
      return (
        <Box marginTop={1}>
          <Text color={SAND}>{`✗ ${item.text}`}</Text>
        </Box>
      );
  }
}
