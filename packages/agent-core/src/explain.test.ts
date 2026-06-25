import assert from "node:assert/strict";
import { test } from "node:test";
import { explainError } from "./explain";

test("explainError: 401 → reconnect hint", () => {
  const e = Object.assign(new Error("GitHub PUT x: 401"), { status: 401 });
  assert.match(explainError(e), /reconnect/i);
});

test("explainError: status parsed from the message when not on the object", () => {
  assert.match(explainError(new Error("GitHub GET PROTOTYPE.md: 404 Not Found")), /couldn't find/i);
});

test("explainError: network failures map to a connection hint", () => {
  const e = Object.assign(new Error("fetch failed"), { code: "ENOTFOUND" });
  assert.match(explainError(e), /network|connection/i);
});

test("explainError: unrecognised errors fall through to their message", () => {
  assert.equal(explainError(new Error("some unexpected thing")), "some unexpected thing");
});
