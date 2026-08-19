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

test("parseAgyEventLine rejects unknown event types", () => {
  assert.throws(() => parseAgyEventLine('{"event":"mystery"}'), /Unknown agy NDJSON event/);
});

test("parseAgyEventLine rejects array-shaped event payloads", () => {
  assert.throws(
    () => parseAgyEventLine('{"event":"init","init":[]}'),
    /object-shaped init payload/,
  );
  assert.throws(
    () => parseAgyEventLine('{"event":"step_update","step_update":[]}'),
    /object-shaped step_update payload/,
  );
  assert.throws(
    () => parseAgyEventLine('{"event":"result","result":[]}'),
    /object-shaped result payload/,
  );
});
