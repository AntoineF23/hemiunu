import { Box, render, Text, useInput } from "ink";
import { useState } from "react";
import { Banner } from "./Banner";
import { SAGE, SAND } from "./theme";

// Launch-time "which team?" picker. One team per terminal — pick here, and for
// parallel work just open another terminal and pick a different team. Arrow to
// move, Enter to choose. The first option is "work locally (no team)".
function LaunchPicker({
  teams,
  current,
  onChoice,
}: {
  teams: string[];
  current: string | null;
  onChoice: (team: string | null) => void;
}) {
  const options: { label: string; value: string | null }[] = [
    { label: "Work locally (no team)", value: null },
    ...teams.map((t) => ({ label: t, value: t })),
  ];
  const initial = Math.max(
    0,
    options.findIndex((o) => o.value === current),
  );
  const [sel, setSel] = useState(initial);
  useInput((_input, key) => {
    const n = options.length;
    if (key.upArrow) setSel((s) => (s - 1 + n) % n);
    else if (key.downArrow) setSel((s) => (s + 1) % n);
    else if (key.return) onChoice(options[sel].value);
  });
  return (
    <Box flexDirection="column">
      <Banner />
      <Box marginTop={1} marginLeft={3} flexDirection="column">
        <Text color={SAND} bold>
          Which team do you want to work on?
        </Text>
        <Text dimColor>{"Open another terminal to work on a second team in parallel."}</Text>
      </Box>
      <Box marginTop={1} marginLeft={3} flexDirection="column">
        {options.map((o, i) => (
          <Text key={o.value ?? "local"} color={i === sel ? SAGE : undefined} dimColor={i !== sel}>
            {i === sel ? "❯ " : "  "}
            {o.label}
          </Text>
        ))}
      </Box>
      <Box marginLeft={3} marginTop={1}>
        <Text dimColor>{"↑/↓ select · Enter to start"}</Text>
      </Box>
    </Box>
  );
}

export function runLaunchPicker(teams: string[], current: string | null): Promise<string | null> {
  return new Promise((resolve) => {
    const { unmount } = render(
      <LaunchPicker
        teams={teams}
        current={current}
        onChoice={(team) => {
          unmount();
          resolve(team);
        }}
      />,
    );
  });
}
