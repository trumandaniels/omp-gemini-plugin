import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

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

export class AgyRunError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly status?: string;

  constructor(
    message: string,
    details: { stderr?: string; exitCode?: number | null; status?: string } = {},
  ) {
    super(message);
    this.name = "AgyRunError";
    this.stderr = details.stderr ?? "";
    this.exitCode = details.exitCode ?? null;
    this.status = details.status;
  }
}

function appendBounded(current: string, chunk: string, limit: number): string {
  if (current.length >= limit) return current;
  const remaining = limit - current.length;
  return current + chunk.slice(0, remaining);
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

/** Run the official agy executable through its documented headless protocol. */
export async function runAgy(options: AgyRunOptions): Promise<AgyRunResult> {
  const bytes = Buffer.byteLength(options.prompt, "utf8");
  if (bytes > options.maxPromptBytes) {
    throw new AgyRunError(
      `OMP context became ${bytes.toLocaleString()} bytes, above AGY_BRIDGE_MAX_PROMPT_BYTES=${options.maxPromptBytes.toLocaleString()}. Compact the OMP session, raise the limit on Linux/WSL, or use delegate mode.`,
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

    const args = ["-p", options.prompt, "--output-format", "stream-json"];
    if (schemaPath) args.push("--json-schema", schemaPath);
    if (options.model) args.push("--model", options.model);
    if (options.effort) args.push("--effort", options.effort);
    if (options.agent) args.push("--agent", options.agent);
    if (options.conversationId) args.push("--conversation", options.conversationId);
    if (options.sandbox) args.push("--sandbox");
    args.push("--print-timeout", options.printTimeout);

    const child = spawn(options.binary, args, {
      cwd: options.cwd,
      env: buildAgyEnvironment(options.sanitizeAccountEnvironment),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
      detached: process.platform !== "win32",
    });

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
          if (events.length < MAX_EVENT_SNAPSHOTS) events.push(event);
          if (event.event === "step_update") {
            if (event.step_update.step_type === "tool" && toolSteps.length < MAX_TOOL_SNAPSHOTS) {
              toolSteps.push(event);
            }
            const discovered = event.step_update.subagent_info?.subagents ?? [];
            for (const subagent of discovered) {
              if (subagents.length >= MAX_SUBAGENT_SNAPSHOTS) break;
              subagents.push(subagent);
            }
          }
          if (event.event === "result") {
            if (terminal) {
              parseFailure = new Error("agy emitted more than one terminal result event");
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

    if (exit.error) {
      throw new AgyRunError(`Could not start ${options.binary}: ${exit.error.message}`, { stderr });
    }
    if (aborted || options.signal?.aborted) {
      throw new AgyRunError("agy run was aborted", { stderr, exitCode: exit.code, status: terminal?.status });
    }
    if (hardTimedOut) {
      throw new AgyRunError(`agy exceeded the host timeout of ${options.hardTimeoutMs} ms`, {
        stderr,
        exitCode: exit.code,
        status: terminal?.status,
      });
    }
    if (callbackFailure) {
      throw new AgyRunError(`agy event callback failed: ${callbackFailure.message}`, {
        stderr,
        exitCode: exit.code,
        status: terminal?.status,
      });
    }
    if (parseFailure) {
      throw new AgyRunError(`Could not parse agy stream: ${parseFailure.message}`, {
        stderr,
        exitCode: exit.code,
        status: terminal?.status,
      });
    }
    if (!terminal) {
      throw new AgyRunError("agy exited without a terminal result event", {
        stderr,
        exitCode: exit.code,
      });
    }
    if (exit.code !== 0 || terminal.status !== "SUCCESS") {
      const diagnostic = terminal.error || stderr.trim() || `status=${String(terminal.status)}`;
      throw new AgyRunError(`agy failed: ${diagnostic}`, {
        stderr,
        exitCode: exit.code,
        status: terminal.status,
      });
    }

    return {
      terminal,
      events,
      stderr,
      exitCode: exit.code,
      signalCode: exit.signal,
      toolSteps,
      subagents,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}
