import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_ENDPOINT = "https://daily-cloudcode-pa.googleapis.com/v1internal:fetchAvailableModels";

interface StoredToken {
  token?: {
    access_token?: unknown;
    expiry?: unknown;
  };
}

interface QuotaInfo {
  remainingFraction?: unknown;
  resetTime?: unknown;
  tier?: unknown;
  windowId?: unknown;
  windowLabel?: unknown;
  apiProvider?: unknown;
  modelProvider?: unknown;
}

interface ModelInfo extends QuotaInfo {
  quotaInfo?: QuotaInfo | QuotaInfo[];
  quotaInfos?: QuotaInfo[];
  dailyQuotaInfo?: QuotaInfo | QuotaInfo[];
  dailyQuotaInfos?: QuotaInfo[];
  weeklyQuotaInfo?: QuotaInfo | QuotaInfo[];
  weeklyQuotaInfos?: QuotaInfo[];
  quotaInfoByTier?: Record<string, QuotaInfo | QuotaInfo[]>;
  quotaInfoByWindow?: Record<string, QuotaInfo | QuotaInfo[]>;
  quotaInfosByWindow?: Record<string, QuotaInfo | QuotaInfo[]>;
}

interface AvailableModelsResponse {
  models?: Record<string, ModelInfo>;
}

export interface AgyQuotaLimit {
  counter: string;
  tier?: string;
  window: string;
  remainingPercent?: number;
  resetsAt?: string;
}

export interface AgyQuotaReport {
  project: string;
  limits: AgyQuotaLimit[];
}

export interface FetchAgyQuotaOptions {
  homeDir?: string;
  fetch?: typeof globalThis.fetch;
  now?: number;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Missing ${label}.`);
  return value.trim();
}

function quotaCounter(info: QuotaInfo): string {
  const provider = info.modelProvider ?? info.apiProvider;
  if (provider === "MODEL_PROVIDER_GOOGLE" || provider === "API_PROVIDER_GOOGLE_GEMINI") return "Gemini";
  if (provider === "MODEL_PROVIDER_ANTHROPIC" || provider === "API_PROVIDER_ANTHROPIC_VERTEX") return "Claude";
  if (provider === "MODEL_PROVIDER_OPENAI" || provider === "API_PROVIDER_OPENAI_VERTEX") return "OpenAI";
  return "Default";
}

function addQuota(target: QuotaInfo[], value: QuotaInfo | QuotaInfo[] | undefined, inherited: QuotaInfo = {}): void {
  if (!value) return;
  for (const item of Array.isArray(value) ? value : [value]) target.push({ ...inherited, ...item });
}

function modelQuotas(model: ModelInfo): QuotaInfo[] {
  const inherited: QuotaInfo = { apiProvider: model.apiProvider, modelProvider: model.modelProvider };
  const quotas: QuotaInfo[] = [];
  addQuota(quotas, model.quotaInfo, inherited);
  addQuota(quotas, model.quotaInfos, inherited);
  addQuota(quotas, model.dailyQuotaInfo, { ...inherited, windowId: "daily", windowLabel: "Daily" });
  addQuota(quotas, model.dailyQuotaInfos, { ...inherited, windowId: "daily", windowLabel: "Daily" });
  addQuota(quotas, model.weeklyQuotaInfo, { ...inherited, windowId: "weekly", windowLabel: "Weekly" });
  addQuota(quotas, model.weeklyQuotaInfos, { ...inherited, windowId: "weekly", windowLabel: "Weekly" });
  for (const [tier, value] of Object.entries(model.quotaInfoByTier ?? {})) addQuota(quotas, value, { ...inherited, tier });
  for (const source of [model.quotaInfoByWindow, model.quotaInfosByWindow]) {
    for (const [windowId, value] of Object.entries(source ?? {})) addQuota(quotas, value, { ...inherited, windowId, windowLabel: windowId });
  }
  return quotas;
}

function finiteFraction(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.min(1, Math.max(0, value));
}

export function parseAgyQuotaResponse(data: AvailableModelsResponse): AgyQuotaLimit[] {
  const limits = new Map<string, AgyQuotaLimit>();
  for (const model of Object.values(data.models ?? {})) {
    for (const quota of modelQuotas(model)) {
      const counter = quotaCounter(quota);
      const tier = typeof quota.tier === "string" && quota.tier ? quota.tier : undefined;
      const window = typeof quota.windowLabel === "string" && quota.windowLabel
        ? quota.windowLabel
        : typeof quota.windowId === "string" && quota.windowId
          ? quota.windowId
          : "Usage";
      const resetsAt = typeof quota.resetTime === "string" && quota.resetTime ? quota.resetTime : undefined;
      const fraction = finiteFraction(quota.remainingFraction);
      const remainingPercent = fraction === undefined ? (resetsAt ? 0 : undefined) : fraction * 100;
      const key = `${counter}\u0000${tier ?? ""}\u0000${window}`;
      const candidate: AgyQuotaLimit = { counter, window, ...(tier ? { tier } : {}), ...(remainingPercent === undefined ? {} : { remainingPercent }), ...(resetsAt ? { resetsAt } : {}) };
      const previous = limits.get(key);
      if (!previous || (candidate.remainingPercent ?? 100) < (previous.remainingPercent ?? 100)) limits.set(key, candidate);
    }
  }
  return [...limits.values()].sort((a, b) => (a.remainingPercent ?? 100) - (b.remainingPercent ?? 100));
}

export async function fetchAgyQuota(options: FetchAgyQuotaOptions = {}): Promise<AgyQuotaReport> {
  const root = join(options.homeDir ?? homedir(), ".gemini", "antigravity-cli");
  const [tokenText, projectText] = await Promise.all([
    readFile(join(root, "antigravity-oauth-token"), "utf8"),
    readFile(join(root, "cache", "default_project_id.txt"), "utf8"),
  ]);
  const stored = JSON.parse(tokenText) as StoredToken;
  const accessToken = requireString(stored.token?.access_token, "Antigravity access token");
  const expiry = Date.parse(requireString(stored.token?.expiry, "Antigravity token expiry"));
  if (!Number.isFinite(expiry) || expiry <= (options.now ?? Date.now())) {
    throw new Error("Antigravity access token is expired. Run agy once to refresh it, then retry /agy-usage.");
  }
  const project = requireString(projectText, "Antigravity project ID");
  const response = await (options.fetch ?? globalThis.fetch)(DEFAULT_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "User-Agent": "antigravity",
    },
    body: JSON.stringify({ project }),
  });
  if (!response.ok) throw new Error(`Antigravity quota request failed: HTTP ${response.status} ${response.statusText}`.trim());
  const limits = parseAgyQuotaResponse(await response.json() as AvailableModelsResponse);
  return { project, limits };
}

export function formatAgyQuota(report: AgyQuotaReport, now = Date.now()): string {
  if (report.limits.length === 0) return "Antigravity returned no quota counters.";
  return report.limits.map(limit => {
    const name = [limit.counter, limit.tier, limit.window].filter(Boolean).join(" · ");
    const remaining = limit.remainingPercent === undefined ? "remaining unknown" : `${Math.round(limit.remainingPercent)}% remaining`;
    const resetMs = limit.resetsAt ? Date.parse(limit.resetsAt) : Number.NaN;
    const reset = Number.isFinite(resetMs)
      ? `; resets ${resetMs <= now ? "now" : new Date(resetMs).toLocaleString()}`
      : "";
    return `${name}: ${remaining}${reset}`;
  }).join("\n");
}
