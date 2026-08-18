export type AgyEffort = "low" | "medium" | "high";

export interface BridgeModelDefinition {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Omit to let the selected Antigravity model decide. */
  effort?: AgyEffort;
}

export interface BridgeConfig {
  providerId: string;
  apiId: string;
  agyBinary: string;
  agentName: string;
  defaultEffort?: AgyEffort;
  printTimeout: string;
  hardTimeoutMs: number;
  sandbox: boolean;
  maxConcurrent: number;
  maxPromptBytes: number;
  maxHistoryChars: number;
  maxToolCatalogChars: number;
  maxToolDescriptionChars: number;
  maxToolSchemaChars: number;
  maxStderrBytes: number;
  killGraceMs: number;
  sanitizeAccountEnvironment: boolean;
  rejectAgyToolUseInProviderMode: boolean;
  enableDelegateTool: boolean;
  discoverModels: boolean;
  includeNonGeminiModels: boolean;
  discoveredContextWindow: number;
  discoveredMaxTokens: number;
  models: BridgeModelDefinition[];
}

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

export interface AgyToolInfo {
  name?: string;
  parameters?: Record<string, unknown>;
  output?: string;
  error?: { type?: string; message?: string };
}

export interface AgySubagentInfo {
  subagents?: Array<{
    type_name?: string;
    role?: string;
    conversation_id?: string;
    log_uri?: string;
    workspace_uris?: string[];
  }>;
}

export interface AgyInitEvent {
  event: "init";
  conversation_id?: string;
  init: {
    cwd?: string;
    tools?: string[];
    permission_mode?: string;
    model?: string;
    agent?: string;
    json_schema?: Record<string, unknown>;
  };
}

export interface AgyStepUpdateEvent {
  event: "step_update";
  step_update: {
    conversation_id?: string;
    step_index?: number;
    state?: "ACTIVE" | "DONE" | string;
    step_type?: "user_input" | "agent_response" | "tool" | "checkpoint" | string;
    tool_name?: string;
    text_delta?: string;
    duration_seconds?: number;
    usage?: AgyUsage;
    tool_info?: AgyToolInfo;
    subagent_info?: AgySubagentInfo;
  };
}

export interface AgyResultPayload {
  conversation_id?: string;
  status?: "SUCCESS" | "ERROR" | "CANCELED" | "INTERRUPTED" | "INVALID" | "WAITING" | "RUNNING" | string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  structured_output?: unknown;
  json_schema?: Record<string, unknown>;
  usage?: AgyUsage;
}

export interface AgyResultEvent {
  event: "result";
  result: AgyResultPayload;
}

export type AgyStreamEvent = AgyInitEvent | AgyStepUpdateEvent | AgyResultEvent;

export interface AgyRunOptions {
  prompt: string;
  cwd: string;
  binary: string;
  model?: string;
  effort?: AgyEffort;
  agent?: string;
  printTimeout: string;
  hardTimeoutMs: number;
  sandbox: boolean;
  maxPromptBytes: number;
  maxStderrBytes: number;
  killGraceMs: number;
  sanitizeAccountEnvironment: boolean;
  schema?: Record<string, unknown>;
  conversationId?: string;
  signal?: AbortSignal;
  onEvent?: (event: AgyStreamEvent) => void | Promise<void>;
}

export interface AgyRunResult {
  terminal: AgyResultPayload;
  events: AgyStreamEvent[];
  stderr: string;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  toolSteps: AgyStepUpdateEvent[];
  subagents: NonNullable<AgySubagentInfo["subagents"]>;
}

export interface BridgeToolCall {
  id?: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface BridgeStructuredOutput {
  text: string;
  tool_calls: BridgeToolCall[];
  finish_reason: "stop" | "tool_use";
}
