import type { Usage } from "@oh-my-pi/pi-ai";

import type { AgyUsage } from "./types.ts";

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

/** Map AGY's aggregate usage fields onto OMP's canonical Usage invariants. */
export function mapAgyUsage(value: AgyUsage | undefined): Usage {
  const rawInput = nonNegativeFinite(value?.input_tokens);
  const cacheRead = nonNegativeFinite(value?.cache_read_tokens) ?? 0;
  const visibleOutput = nonNegativeFinite(value?.output_tokens) ?? 0;
  const thinkingTokens = nonNegativeFinite(value?.thinking_tokens);

  // AGY reports thinking in its own bucket. OMP requires reasoningTokens to be
  // a subset of output, so fold the thinking bucket into OMP's total output.
  const output = visibleOutput + (thinkingTokens ?? 0);
  const input = rawInput === undefined ? 0 : Math.max(0, rawInput - cacheRead);
  const bucketTotal = input + cacheRead + output;
  const reportedTotal = nonNegativeFinite(value?.total_tokens);

  return {
    input,
    output,
    cacheRead,
    cacheWrite: 0,
    totalTokens: Math.max(bucketTotal, reportedTotal ?? bucketTotal),
    ...(thinkingTokens === undefined ? {} : { reasoningTokens: thinkingTokens }),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  } as Usage;
}

/** Add usage for multiple provider attempts without turning unknown reasoning into zero. */
export function addUsage(left: Usage, right: Usage): Usage {
  const reasoningTokens = left.reasoningTokens !== undefined && right.reasoningTokens !== undefined
    ? left.reasoningTokens + right.reasoningTokens
    : undefined;

  return {
    input: left.input + right.input,
    output: left.output + right.output,
    cacheRead: left.cacheRead + right.cacheRead,
    cacheWrite: left.cacheWrite + right.cacheWrite,
    totalTokens: left.totalTokens + right.totalTokens,
    ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    cost: {
      input: left.cost.input + right.cost.input,
      output: left.cost.output + right.cost.output,
      cacheRead: left.cost.cacheRead + right.cost.cacheRead,
      cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
      total: left.cost.total + right.cost.total,
    },
  } as Usage;
}
