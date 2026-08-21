import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fetchAgyQuota, formatAgyQuota, parseAgyQuotaResponse } from "../src/agy-usage.ts";

test("parseAgyQuotaResponse separates provider counters and keeps the tightest duplicate", () => {
  const limits = parseAgyQuotaResponse({
    models: {
      "gemini-a": {
        modelProvider: "MODEL_PROVIDER_GOOGLE",
        dailyQuotaInfo: { remainingFraction: 0.4, resetTime: "2026-08-21T00:00:00Z" },
      },
      "gemini-b": {
        modelProvider: "MODEL_PROVIDER_GOOGLE",
        dailyQuotaInfo: { remainingFraction: 0.25, resetTime: "2026-08-21T00:00:00Z" },
      },
      claude: {
        modelProvider: "MODEL_PROVIDER_ANTHROPIC",
        weeklyQuotaInfo: { remainingFraction: 0.8, resetTime: "2026-08-25T00:00:00Z" },
      },
    },
  });

  assert.deepEqual(limits, [
    { counter: "Gemini", window: "Daily", remainingPercent: 25, resetsAt: "2026-08-21T00:00:00Z" },
    { counter: "Claude", window: "Weekly", remainingPercent: 80, resetsAt: "2026-08-25T00:00:00Z" },
  ]);
});

test("parseAgyQuotaResponse treats reset-only counters as exhausted", () => {
  assert.deepEqual(parseAgyQuotaResponse({
    models: {
      gemini: {
        apiProvider: "API_PROVIDER_GOOGLE_GEMINI",
        quotaInfoByTier: { pro: { resetTime: "2026-08-21T00:00:00Z", windowLabel: "Daily" } },
      },
    },
  }), [
    { counter: "Gemini", tier: "pro", window: "Daily", remainingPercent: 0, resetsAt: "2026-08-21T00:00:00Z" },
  ]);
});

test("fetchAgyQuota reads local state and sends only the access token and project", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "agy-usage-"));
  const root = join(homeDir, ".gemini", "antigravity-cli");
  await mkdir(join(root, "cache"), { recursive: true });
  await writeFile(join(root, "antigravity-oauth-token"), JSON.stringify({
    token: { access_token: "secret-access", refresh_token: "must-not-leak", expiry: "2030-01-01T00:00:00Z" },
  }));
  await writeFile(join(root, "cache", "default_project_id.txt"), "project-123\n");

  let request: { url: string; init?: RequestInit } | undefined;
  const report = await fetchAgyQuota({
    homeDir,
    now: Date.parse("2026-08-20T00:00:00Z"),
    fetch: async (input, init) => {
      request = { url: String(input), init };
      return new Response(JSON.stringify({ models: {} }), { status: 200 });
    },
  });

  assert.equal(request?.url, "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels");
  assert.equal(new Headers(request?.init?.headers).get("authorization"), "Bearer secret-access");
  assert.doesNotMatch(JSON.stringify(request?.init), /must-not-leak/);
  assert.equal(request?.init?.body, JSON.stringify({ project: "project-123" }));
  assert.deepEqual(report, { project: "project-123", limits: [] });
});

test("fetchAgyQuota rejects expired local credentials before network access", async () => {
  const homeDir = await mkdtemp(join(tmpdir(), "agy-usage-expired-"));
  const root = join(homeDir, ".gemini", "antigravity-cli");
  await mkdir(join(root, "cache"), { recursive: true });
  await writeFile(join(root, "antigravity-oauth-token"), JSON.stringify({
    token: { access_token: "expired", expiry: "2020-01-01T00:00:00Z" },
  }));
  await writeFile(join(root, "cache", "default_project_id.txt"), "project-123");

  await assert.rejects(
    fetchAgyQuota({ homeDir, now: Date.parse("2026-08-20T00:00:00Z"), fetch: async () => { throw new Error("network called"); } }),
    /Run agy once to refresh it/,
  );
});

test("formatAgyQuota renders remaining quota and reset time", () => {
  const text = formatAgyQuota({
    project: "project-123",
    limits: [{ counter: "Gemini", tier: "pro", window: "Daily", remainingPercent: 42.4, resetsAt: "2026-08-21T00:00:00Z" }],
  }, Date.parse("2026-08-20T00:00:00Z"));
  assert.match(text, /^Gemini · pro · Daily: 42% remaining; resets /);
});
