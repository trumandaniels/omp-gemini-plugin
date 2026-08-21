import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { isDeepStrictEqual } from "node:util";

import { buildAgyEnvironment } from "../env.ts";
import { parseAgyEventLine } from "./ndjson.ts";
import type {
  AgyRunOptions,
  AgyRunResult,
  AgyStepUpdateEvent,
  AgyStreamEvent,
} from "../types.ts";

const MAX_EVENT_SNAPSHOTS = 2_000;
const MAX_TOOL_SNAPSHOTS = 500;
const MAX_SUBAGENT_SNAPSHOTS = 500;
const MAX_NDJSON_LINE_BYTES = 4 * 1024 * 1024;
const MAX_DIAGNOSTIC_CHARS = 2_000;
const AGY_ACCOUNT_BOOTSTRAP_FIX_VERSION = "1.1.15";
const AGY_ACCOUNT_BOOTSTRAP_FAILURE = /\beligibility check failed\b[\s\S]*\bload code assist\b[\s\S]*\bresource_exhausted\b/i;

export interface AgyRunErrorDetails {
  stderr?: string;
  exitCode?: number | null;
  signalCode?: NodeJS.Signals | null;
  status?: string;
  terminal?: AgyRunResult["terminal"];
  events?: readonly AgyStreamEvent[];
  toolSteps?: readonly AgyStepUpdateEvent[];
  subagents?: readonly AgyRunResult["subagents"][number][];
  eventCount?: number;
  toolStepCount?: number;
  subagentCount?: number;
}

export class AgyRunError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  readonly status?: string;
  readonly terminal?: AgyRunResult["terminal"];
  readonly events: AgyStreamEvent[];
  readonly toolSteps: AgyStepUpdateEvent[];
  readonly subagents: AgyRunResult["subagents"];
  readonly eventCount: number;
  readonly toolStepCount: number;
  readonly subagentCount: number;

  constructor(message: string, details: AgyRunErrorDetails = {}) {
    super(message);
    this.name = "AgyRunError";
    this.stderr = details.stderr ?? "";
    this.exitCode = details.exitCode ?? null;
    this.signalCode = details.signalCode ?? null;
    this.status = details.status;
    this.terminal = details.terminal;
    this.events = [...(details.events ?? [])];
    this.toolSteps = [...(details.toolSteps ?? [])];
    this.subagents = [...(details.subagents ?? [])];
    this.eventCount = details.eventCount ?? this.events.length;
    this.toolStepCount = details.toolStepCount ?? this.toolSteps.length;
    this.subagentCount = details.subagentCount ?? this.subagents.length;
  }
}

function appendBounded(current: string, chunk: string, limit: number): string {
  if (current.length >= limit) return current;
  const remaining = limit - current.length;
  return current + chunk.slice(0, remaining);
}

function diagnosticText(value: unknown): string {
  if (typeof value === "string") return value.trim().slice(0, MAX_DIAGNOSTIC_CHARS);
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value).slice(0, MAX_DIAGNOSTIC_CHARS);
  } catch {
    return String(value).slice(0, MAX_DIAGNOSTIC_CHARS);
  }
}

function isAgyAccountBootstrapFailure(...values: unknown[]): boolean {
  return values.some((value) => AGY_ACCOUNT_BOOTSTRAP_FAILURE.test(diagnosticText(value)));
}

function agyAccountBootstrapFailureMessage(): string {
  return `agy account bootstrap failed before model execution. Upgrade the official Antigravity CLI to ${AGY_ACCOUNT_BOOTSTRAP_FIX_VERSION} or newer in the same environment as OMP, then fully restart OMP. Antigravity CLI ${AGY_ACCOUNT_BOOTSTRAP_FIX_VERSION} fixes personal-account startup eligibility failures when credentials are restored from the system keyring. If a direct agy -p smoke test still fails after the upgrade, the failure is upstream of this bridge.`;
}

function terminateProcessTree(child: ChildProcess, graceMs: number): NodeJS.Timeout | undefined {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return undefined;

  try {
    if (process.platform === "win32") child.kill("SIGTERM");
    else process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      return undefined;
    }
  }

  const timer = setTimeout(() => {
    if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
    try {
      if (process.platform === "win32") {
        const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
          shell: false,
        });
        killer.unref();
      } else {
        process.kill(-child.pid, "SIGKILL");
      }
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Process has already exited.
      }
    }
  }, graceMs);
  timer.unref?.();
  return timer;
}

/** Run the official agy executable through its headless stream-json protocol. */
export async function runAgy(options: AgyRunOptions): Promise<AgyRunResult> {
  const bytes = Buffer.byteLength(options.prompt, "utf8");
  if (bytes > options.maxPromptBytes) {
    throw new AgyRunError(
      `OMP context became ${bytes.toLocaleString()} bytes, above AGY_BRIDGE_MAX_PROMPT_BYTES=${options.maxPromptBytes.toLocaleString()}. Compact the OMP session, raise the limit, or use delegate mode.`,
    );
  }
  if (options.signal?.aborted) {
    throw new AgyRunError("agy run was aborted before start");
  }

  const tempDir = await mkdtemp(join(tmpdir(), "omp-agy-bridge-"));
  let schemaPath: string | undefined;
  try {
    if (options.schema) {
      schemaPath = join(tempDir, "response.schema.json");
      await writeFile(schemaPath, JSON.stringify(options.schema), { encoding: "utf8", mode: 0o600 });
    }

    // Do not place the complete OMP context in argv. Large sessions can exceed
    // the host's execve/posix_spawn argument budget (E2BIG) before agy starts.
    // Current AGY print mode consumes a non-TTY stdin prompt when no -p/--print
    // prompt value is supplied, which also keeps prompt contents out of ps output.
    const args = ["--output-format", "stream-json"];
    if (schemaPath) args.push("--json-schema", schemaPath);
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    if (options.agent) args.push("--agent", options.agent);
    if (options.conversationId) args.push("--conversation", options.conversationId);
    if (options.sandbox) args.push("--sandbox");
    args.push("--print-timeout", options.printTimeout);

    const providerEnvironment = options.providerBoundary
      ? {
          OMP_AGY_PROVIDER_MODE: "1",
          OMP_AGY_PROVIDER_MEDIA_PATHS: JSON.stringify(options.providerBoundary.allowedMediaPaths ?? []),
        }
      : {};

    const child = spawn(options.binary, args, {
      cwd: options.cwd,
      env: buildAgyEnvironment(options.sanitizeAccountEnvironment, process.env, providerEnvironment),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
    });

    let stdinFailure: Error | undefined;
    if (!child.stdin) {
      stdinFailure = new Error("agy stdin pipe was not created");
    } else {
      child.stdin.once("error", (error) => {
        stdinFailure = error;
      });
      child.stdin.end(options.prompt, "utf8");
    }

    const completion = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
      error?: Error;
    }>((resolve) => {
      let settled = false;
      const finish = (value: { code: number | null; signal: NodeJS.Signals | null; error?: Error }) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      child.once("error", (error) => finish({ code: null, signal: null, error }));
      child.once("close", (code, signal) => finish({ code, signal }));
    });

    let stderr = "";
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk, options.maxStderrBytes);
    });

    let forceKillTimer: NodeJS.Timeout | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    let aborted = false;
    let hardTimedOut = false;
    let terminating = false;
    const terminate = () => {
      if (terminating) return;
      terminating = true;
      forceKillTimer = terminateProcessTree(child, options.killGraceMs);
    };

    const onAbort = () => {
      aborted = true;
      terminate();
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    hardTimer = setTimeout(() => {
      hardTimedOut = true;
      terminate();
    }, options.hardTimeoutMs);
    hardTimer.unref?.();

    const events: AgyStreamEvent[] = [];
    const toolSteps: AgyStepUpdateEvent[] = [];
    const subagents: AgyRunResult["subagents"] = [];
    let eventCount = 0;
    let toolStepCount = 0;
    let subagentCount = 0;
    let terminal: AgyRunResult["terminal"] | undefined;
    let parseFailure: Error | undefined;
    let callbackFailure: Error | undefined;

    if (child.stdout) {
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      try {
        for await (const line of lines) {
          if (Buffer.byteLength(line, "utf8") > MAX_NDJSON_LINE_BYTES) {
            parseFailure = new Error(`agy emitted an NDJSON line larger than ${MAX_NDJSON_LINE_BYTES} bytes`);
            terminate();
            break;
          }

          let event: AgyStreamEvent | undefined;
          try {
            event = parseAgyEventLine(line);
          } catch (error) {
            parseFailure = error instanceof Error ? error : new Error(String(error));
            terminate();
            break;
          }
          if (!event) continue;
          eventCount += 1;
          if (events.length < MAX_EVENT_SNAPSHOTS) events.push(event);
          if (event.event === "step_update") {
            if (event.step_update.step_type === "tool") {
              toolStepCount += 1;
              if (toolSteps.length < MAX_TOOL_SNAPSHOTS) toolSteps.push(event);
            }
            const rawSubagents = event.step_update.subagent_info?.subagents as unknown;
            if (rawSubagents !== undefined && !Array.isArray(rawSubagents)) {
              parseFailure = new Error("agy step_update subagent_info.subagents must be an array");
              terminate();
              break;
            }
            const discovered = Array.isArray(rawSubagents) ? rawSubagents : [];
            subagentCount += discovered.length;
            for (const subagent of discovered) {
              if (subagents.length >= MAX_SUBAGENT_SNAPSHOTS) break;
              if (!subagent || typeof subagent !== "object" || Array.isArray(subagent)) {
                parseFailure = new Error("agy subagent entry must be an object");
                terminate();
                break;
              }
              subagents.push(subagent as AgyRunResult["subagents"][number]);
            }
            if (parseFailure) break;
          }
          if (event.event === "result") {
            if (terminal) {
              // AGY/model wrappers have duplicated other terminal payloads in the
              // wild. An exact duplicate result is representation noise and safe
              // to ignore. A conflicting second terminal remains a protocol error.
              if (isDeepStrictEqual(terminal, event.result)) continue;
              parseFailure = new Error("agy emitted conflicting terminal result events");
              terminate();
              break;
            }
            terminal = event.result;
          }
          try {
            await options.onEvent?.(event);
          } catch (error) {
            callbackFailure = error instanceof Error ? error : new Error(String(error));
            terminate();
            break;
          }
        }
      } finally {
        lines.close();
      }
    }

    const exit = await completion;
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (hardTimer) clearTimeout(hardTimer);
    options.signal?.removeEventListener("abort", onAbort);

    const failureDetails = (): AgyRunErrorDetails => ({
      stderr,
      exitCode: exit.code,
      signalCode: exit.signal,
      status: terminal?.status,
      terminal,
      events,
      toolSteps,
      subagents,
      eventCount,
      toolStepCount,
      subagentCount,
    });

    if (exit.error) {
      throw new AgyRunError(`Could not start ${options.binary}: ${exit.error.message}`, failureDetails());
    }
    if (stdinFailure) {
      throw new AgyRunError(`Could not send prompt to ${options.binary} over stdin: ${stdinFailure.message}`, failureDetails());
    }
    if (aborted || options.signal?.aborted) {
      throw new AgyRunError("agy run was aborted", failureDetails());
    }
    if (hardTimedOut) {
      throw new AgyRunError(`agy exceeded the host timeout of ${options.hardTimeoutMs} ms`, failureDetails());
    }
    if (callbackFailure) {
      throw new AgyRunError(`agy event callback failed: ${callbackFailure.message}`, failureDetails());
    }
    if (parseFailure) {
      throw new AgyRunError(`Could not parse agy stream: ${parseFailure.message}`, failureDetails());
    }
    if (!terminal) {
      throw new AgyRunError("agy exited without a terminal result event", failureDetails());
    }
    if (exit.code !== 0 || terminal.status !== "SUCCESS") {
      const diagnostic = diagnosticText(terminal.error) || stderr.trim() || `status=${String(terminal.status)}`;
      if (isAgyAccountBootstrapFailure(terminal.error, stderr, diagnostic)) {
        throw new AgyRunError(agyAccountBootstrapFailureMessage(), failureDetails());
      }
      throw new AgyRunError(`agy failed: ${diagnostic}`, failureDetails());
    }

    return {
      terminal,
      events,
      stderr,
      exitCode: exit.code,
      signalCode: exit.signal,
      toolSteps,
      subagents,
      eventCount,
      toolStepCount,
      subagentCount,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
