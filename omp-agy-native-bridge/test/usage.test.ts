import assert from "node:assert/strict";
import test from "node:test";

import { addUsage, mapAgyUsage } from "../src/usage.ts";

test("mapAgyUsage preserves documented AGY and OMP bucket invariants", () => {
  const usage = mapAgyUsage({
    input_tokens: 10,
    cache_read_tokens: 2,
    output_tokens: 7,
    thinking_tokens: 3,
    total_tokens: 17,
  });

  assert.deepEqual(
    {
      input: usage.input,
      cacheRead: usage.cacheRead,
      output: usage.output,
      reasoningTokens: usage.reasoningTokens,
      totalTokens: usage.totalTokens,
    },
    {
      input: 8,
      cacheRead: 2,
      output: 7,
      reasoningTokens: 3,
      totalTokens: 17,
    },
  );
});

test("mapAgyUsage does not double-count thinking already included in AGY output", () => {
  const usage = mapAgyUsage({
    input_tokens: 10_522,
    cache_read_tokens: 8_112,
    output_tokens: 354,
    thinking_tokens: 329,
    total_tokens: 10_876,
  });
  assert.equal(usage.input, 2_410);
  assert.equal(usage.cacheRead, 8_112);
  assert.equal(usage.output, 354);
  assert.equal(usage.reasoningTokens, 329);
  assert.equal(usage.totalTokens, 10_876);
});

test("mapAgyUsage repairs an under-reported total from disjoint OMP buckets", () => {
  const usage = mapAgyUsage({
    input_tokens: 10,
    cache_read_tokens: 2,
    output_tokens: 7,
    thinking_tokens: 3,
    total_tokens: 14,
  });
  assert.equal(usage.totalTokens, 17);
});

test("mapAgyUsage clamps malformed cache and reasoning combinations", () => {
  const usage = mapAgyUsage({
    input_tokens: 2,
    cache_read_tokens: 5,
    output_tokens: 1,
    thinking_tokens: 3,
    total_tokens: 6,
  });
  assert.equal(usage.input, 0);
  assert.equal(usage.cacheRead, 5);
  assert.equal(usage.output, 3);
  assert.equal(usage.reasoningTokens, 3);
  assert.equal(usage.totalTokens, 8);
});

test("mapAgyUsage leaves unknown reasoning undefined", () => {
  const usage = mapAgyUsage({ input_tokens: 4, output_tokens: 2, total_tokens: 6 });
  assert.equal(usage.reasoningTokens, undefined);
});

test("mapAgyUsage rejects non-finite and negative counters without producing NaN", () => {
  const usage = mapAgyUsage({
    input_tokens: Number.NaN,
    output_tokens: Number.POSITIVE_INFINITY,
    thinking_tokens: -1,
    cache_read_tokens: -5,
    total_tokens: Number.NaN,
  });
  assert.equal(usage.input, 0);
  assert.equal(usage.output, 0);
  assert.equal(usage.cacheRead, 0);
  assert.equal(usage.totalTokens, 0);
  assert.equal(usage.reasoningTokens, undefined);
});

test("addUsage does not turn an unknown reasoning count into zero", () => {
  const known = mapAgyUsage({ input_tokens: 2, output_tokens: 2, thinking_tokens: 1, total_tokens: 4 });
  const unknown = mapAgyUsage({ input_tokens: 3, output_tokens: 2, total_tokens: 5 });
  const combined = addUsage(known, unknown);

  assert.equal(combined.input, 5);
  assert.equal(combined.output, 4);
  assert.equal(combined.totalTokens, 9);
  assert.equal(combined.reasoningTokens, undefined);
});
