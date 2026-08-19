import assert from "node:assert/strict";
import test from "node:test";

import { parseAgyEventLine } from "../src/agy/ndjson.ts";

test("parseAgyEventLine accepts init, update, and result", () => {
  assert.equal(parseAgyEventLine("   "), undefined);
  assert.equal(parseAgyEventLine('{"event":"init","init":{"tools":[]}}')?.event, "init");
  assert.equal(
    parseAgyEventLine('{"event":"step_update","step_update":{"step_type":"agent_response"}}')?.event,
    "step_update",
  );
  assert.equal(parseAgyEventLine('{"event":"result","result":{"status":"SUCCESS"}}')?.event, "result");
});

test("parseAgyEventLine ignores unknown future progress events", () => {
  assert.equal(
    parseAgyEventLine('{"event":"progress","progress":{"message":"new AGY event"}}'),
    undefined,
  );
});

test("parseAgyEventLine still rejects malformed known events", () => {
  assert.throws(() => parseAgyEventLine('{"event":"init","init":[]}'), /missing init payload/);
  assert.throws(() => parseAgyEventLine('{"event":"step_update","step_update":"bad"}'), /missing step_update payload/);
  assert.throws(() => parseAgyEventLine('{"event":"result","result":null}'), /missing result payload/);
  assert.throws(() => parseAgyEventLine('{"not_event":"mystery"}'), /non-empty string event name/);
});
