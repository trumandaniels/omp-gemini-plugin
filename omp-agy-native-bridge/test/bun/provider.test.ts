import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "bun:test";

import type { Api, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";

import { DEFAULT_CONFIG } from "../../src/config.ts";
import { createAgyProviderStream } from "../../src/provider.ts";
import { Semaphore } from "../../src/semaphore.ts";
import type { BridgeConfig } from "../../src/types.ts";

const fakeAgy = fileURLToPath(new URL("../fixtures/fake-agy", import.meta.url));
await chmod(fakeAgy, 0o755);

function config(): BridgeConfig {
  return {
    ...DEFAULT_CONFIG,
    agyBinary: fakeAgy,
    hardTimeoutMs: 10_000,
    printTimeout: "1m",
    maxPromptBytes: 1_000_000,
    killGraceMs: 100,
    discoverModels: false,
    models: [
      {
        id: "fake-model",
        name: "Fake model",
        reasoning: true,
        contextWindow: 100_000,
        maxTokens: 10_000,
        agyModelId: "fake-model",
      },
    ],
  };
}

function model(bridge: BridgeConfig): Model<Api> {
  return {
    id: "fake-model",
    name: "Fake model",
    api: bridge.apiId as Api,
    provider: bridge.providerId,
    baseUrl: "http://127.0.0.1/official-agy-cli",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 100_000,
    maxTokens: 10_000,
    compat: {},
  };
}

function context(text: string): Context {
  return {
    systemPrompt: ["Use only OMP tools."],
    messages: [
      {
        role: "user",
        content: text,
        timestamp: Date.now(),
      },
    ],
    tools: [],
  };
}

test("provider retries a rejected AGY send_message once and returns an OMP response", async () => {
  const bridge = config();
  const streamSimple = createAgyProviderStream(bridge, new Semaphore(1), process.cwd());
  const stream = streamSimple(
    model(bridge),
    context("FAKE:RECIPIENT_NOT_FOUND"),
    { cwd: process.cwd() } satisfies SimpleStreamOptions,
  );
  const response = await stream.result();

  assert.equal(response.stopReason, "stop");
  assert.deepEqual(response.content, [{ type: "text", text: "ok" }]);
  assert.equal(response.usage.input, 15);
  assert.equal(response.usage.output, 6);
  assert.equal(response.usage.cacheRead, 2);
  assert.equal(response.usage.totalTokens, 23);
});

test("provider honors OMP StreamOptions.cwd for child task/worktree calls", async () => {
  const bridge = config();
  const fallbackCwd = await mkdtemp(join(tmpdir(), "agy-provider-fallback-"));
  const requestCwd = await mkdtemp(join(tmpdir(), "agy-provider-request-"));
  try {
    const streamSimple = createAgyProviderStream(bridge, new Semaphore(1), fallbackCwd);
    const stream = streamSimple(
      model(bridge),
      context("FAKE:REPORT_CWD"),
      { cwd: requestCwd } satisfies SimpleStreamOptions,
    );
    const response = await stream.result();
    const text = response.content.find((block) => block.type === "text");
    assert.equal(text?.text, resolve(requestCwd));
  } finally {
    await Promise.all([
      rm(fallbackCwd, { recursive: true, force: true }),
      rm(requestCwd, { recursive: true, force: true }),
    ]);
  }
});
