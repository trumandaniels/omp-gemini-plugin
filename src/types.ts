export type AgyEffort = "low" | "medium" | "high";

export interface BridgeModelDefinition {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  /** Optional default effort for this logical model. */
  effort?: AgyEffort;
  /** Exact slug passed to `agy --model` for a non-tiered model. */
  agyModelId?: string;
  /** Exact tiered slugs passed to `agy --model`, keyed by OMP thinking effort. */
  agyModelIdsByEffort?: Partial<Record<AgyEffort, string>>;
  /** Explicit image-input override. When omitted, Gemini logical models are inferred as multimodal. */
  supportsImages?: boolean;
  /** Compatibility alias for model catalogs/configs that describe image support as capabilities. */
  capabilities?: {
    image?: boolean;
    vision?: boolean;
  };
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
  enableImageInput: boolean;
  maxImageCount: number;
  maxImageBytes: number;
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
  /** Additional isolated directories that AGY may resolve explicit prompt attachments from. */
  additionalWorkspaceDirectories?: readonly string[];
  /** Enables the installed pre-tool safety boundary for a provider-mode process only. */
  providerBoundary?: {
    allowedMediaPaths?: readonly string[];
  };
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
  /** Total events observed before snapshot caps; omitted by older/fabricated results. */
  eventCount?: number;
  /** Total AGY tool lifecycle updates observed before snapshot caps. */
  toolStepCount?: number;
  /** Total AGY subagent records observed before snapshot caps. */
  subagentCount?: number;
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
