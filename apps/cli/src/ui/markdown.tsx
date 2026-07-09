import { Text } from "ink";
import React from "react";
import { SAGE, SAND } from "./theme";

// Minimal inline markdown → Ink nodes: **bold**, `code`.
export function mdInline(line: string, li: number): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`)/g;
  let last = 0;
  let k = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) out.push(line.slice(last, m.index));
    if (m[2] !== undefined)
      out.push(
        <Text key={`b${li}-${k}`} bold>
          {m[2]}
        </Text>,
      );
    else if (m[3] !== undefined)
      out.push(
        <Text key={`c${li}-${k}`} color={SAGE}>
          {m[3]}
        </Text>,
      );
    last = m.index + m[0].length;
    k++;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

// Render text as markdown: # headers (bold) + inline bold/code.
export function md(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  text.split("\n").forEach((line, li) => {
    if (li > 0) nodes.push("\n");
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      nodes.push(
        <Text key={`h${li}`} bold color={SAND}>
          {h[2]}
        </Text>,
      );
    } else {
      nodes.push(...mdInline(line, li));
    }
  });
  return nodes;
}
