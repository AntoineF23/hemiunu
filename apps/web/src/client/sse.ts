import type { ServerEvent } from "../shared/protocol";

/**
 * Parse one SSE frame's `data:` payload into JSON, or null if the frame has no
 * data line or the payload is malformed. Per the SSE spec a frame may carry
 * multiple `data:` lines, which concatenate with a newline — so we join them
 * rather than reading only the first.
 */
export function parseSseFrame(frame: string): ServerEvent | null {
  const data = frame
    .split("\n")
    .filter((l) => l.startsWith("data:"))
    .map((l) => l.slice(5).replace(/^ /, "")) // strip "data:" + one optional space
    .join("\n")
    .trim();
  if (!data) return null;
  try {
    return JSON.parse(data) as ServerEvent;
  } catch {
    return null; // ignore malformed frame
  }
}

/** Parse a fetch stream as SSE, yielding each frame's parsed `data:` JSON. */
export async function* sseFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<ServerEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const frame = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const e = parseSseFrame(frame);
      if (e) yield e;
    }
  }
}
