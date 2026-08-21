#!/usr/bin/env node
"use strict";

const path = require("node:path");
const { fileURLToPath } = require("node:url");

const PROVIDER_MODE_ENV = "OMP_AGY_PROVIDER_MODE";
const PROVIDER_MEDIA_ENV = "OMP_AGY_PROVIDER_MEDIA_PATHS";
const BLOCK_MARKER = "OMP_AGY_PROVIDER_TOOL_BLOCKED_V1";

function normalizedName(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isReadOnlyMediaTool(value) {
  return /^(?:read|view|inspect|load)(?:file|files|image|images|media|attachment|attachments)(?:content)?$/.test(
    normalizedName(value),
  );
}

function isFileTargetKey(value) {
  const key = normalizedName(value);
  return key.endsWith("path")
    || key.endsWith("paths")
    || key === "file"
    || key === "files"
    || key === "filename"
    || key === "filenames"
    || key === "uri"
    || key === "uris";
}

function collectFileTargets(value, parentKey = "") {
  if (typeof value === "string") return isFileTargetKey(parentKey) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => collectFileTargets(item, parentKey));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, child]) => collectFileTargets(child, key));
}

function canonicalPath(value, cwd) {
  let candidate = String(value ?? "").trim();
  if (candidate.startsWith("@")) candidate = candidate.slice(1);
  try {
    if (candidate.startsWith("file://")) candidate = fileURLToPath(candidate);
  } catch {
    return undefined;
  }
  if (!candidate) return undefined;
  const absolute = path.resolve(cwd, candidate);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function allowedMediaRead(toolCall, input, env) {
  if (!isReadOnlyMediaTool(toolCall?.name)) return false;
  let configured;
  try {
    configured = JSON.parse(env[PROVIDER_MEDIA_ENV] ?? "[]");
  } catch {
    return false;
  }
  if (!Array.isArray(configured) || configured.some((item) => typeof item !== "string")) return false;
  const cwd = Array.isArray(input?.workspacePaths) && typeof input.workspacePaths[0] === "string"
    ? input.workspacePaths[0]
    : process.cwd();
  const files = new Set(configured.map((item) => canonicalPath(item, cwd)).filter(Boolean));
  if (files.size === 0) return false;
  const directories = new Set([...files].map(path.dirname));
  const targets = collectFileTargets(toolCall?.args ?? {});
  return targets.length > 0 && targets.every((target) => {
    const canonical = canonicalPath(target, cwd);
    return canonical && (files.has(canonical) || directories.has(canonical));
  });
}

function safeControlProbe(toolCall) {
  const name = normalizedName(toolCall?.name);
  const args = toolCall?.args;
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const actionEntry = Object.entries(args).find(([key]) => normalizedName(key) === "action");
  const action = normalizedName(actionEntry?.[1]);
  return (name === "managetask" && (action === "list" || action === "status"))
    || (name === "managesubagents" && action === "list");
}

function decide(input, env = process.env) {
  if (env[PROVIDER_MODE_ENV] !== "1") return { decision: "allow" };
  if (allowedMediaRead(input?.toolCall, input, env)) return { decision: "allow" };
  if (safeControlProbe(input?.toolCall)) return { decision: "allow" };
  return {
    decision: "deny",
    reason: `${BLOCK_MARKER}: Provider mode forbids Antigravity-native actions. Return the enforced terminal JSON object directly; request host actions only through an opaque alias in its outer tool_calls array.`,
  };
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    input = {};
  }
  process.stdout.write(`${JSON.stringify(decide(input))}\n`);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = { BLOCK_MARKER, decide };
