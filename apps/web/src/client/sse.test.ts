import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSseFrame, sseFrames } from "./sse";

test("parseSseFrame: parses a single data line", () => {
  assert.deepEqual(parseSseFrame('data: {"type":"turn","turnId":"t1"}'), {
    type: "turn",
    turnId: "t1",
  });
});

test("parseSseFrame: concatenates multiple data lines (SSE multi-line payload)", () => {
  const frame = 'data: {"type":"note",\ndata: "text":"hi"}';
  assert.deepEqual(parseSseFrame(frame), { type: "note", text: "hi" });
});

test("parseSseFrame: returns null for a frame with no data line", () => {
  assert.equal(parseSseFrame("event: ping\nid: 5"), null);
});

test("parseSseFrame: returns null for malformed JSON instead of throwing", () => {
  assert.equal(parseSseFrame("data: {not json"), null);
});

/** Build a ReadableStream that emits the given chunks as UTF-8 bytes. */
function streamOf(...chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      controller.close();
    },
  });
}

test("sseFrames: yields each complete frame's parsed event", async () => {
  const body = streamOf(
    'data: {"type":"turn","turnId":"t1"}\n\n',
    'data: {"type":"note","text":"working"}\n\n',
  );
  const out = [];
  for await (const e of sseFrames(body)) out.push(e);
  assert.deepEqual(out, [
    { type: "turn", turnId: "t1" },
    { type: "note", text: "working" },
  ]);
});

test("sseFrames: reassembles a frame split across chunk boundaries", async () => {
  const body = streamOf('data: {"type":"tu', 'rn","turnId":"t1"}\n\n');
  const out = [];
  for await (const e of sseFrames(body)) out.push(e);
  assert.deepEqual(out, [{ type: "turn", turnId: "t1" }]);
});

test("sseFrames: skips a malformed frame and keeps parsing the next", async () => {
  const body = streamOf('data: {bad\n\ndata: {"type":"note","text":"ok"}\n\n');
  const out = [];
  for await (const e of sseFrames(body)) out.push(e);
  assert.deepEqual(out, [{ type: "note", text: "ok" }]);
});
