export type ApiFormat = "openai" | "anthropic" | "gemini";
export type AppRunState = "starting" | "running" | "applying" | "error" | "stopped";
export type TaskStatus =
  | "queued"
  | "retry_wait"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled";
export type ReasoningEffort = "low" | "medium" | "high";
export type WorkerOutputFormat = "text" | "json";

export interface Artifact {
  type: string;
  name: string;
  uri?: string | undefined;
  content?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ChannelAddress {
  channel: string;
  conversationId: string;
  recipientId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface ToolPolicy {
  allow?: string[] | undefined;
  deny?: string[] | undefined;
}

export interface MemoryPolicy {
  read: boolean;
  write: boolean;
}

export interface WorkerProfile {
  id: string;
  description: string;
  capabilities: string[];
  model?: string | undefined;
  reasoningEffort?: ReasoningEffort | undefined;
  outputFormat: WorkerOutputFormat;
  systemPrompt?: string | undefined;
  tools: ToolPolicy;
  memory: MemoryPolicy;
  generation?: Record<string, unknown> | undefined;
}

export interface WorkerResult {
  summary: string;
  data?: unknown;
  artifacts?: Artifact[] | undefined;
  raw?: string | undefined;
}

export interface TaskSummary {
  id: string;
  runId: string;
  workerId: string;
  status: TaskStatus;
  attempt: number;
  attempts: number;
  maxAttempts: number;
  priority: number;
  input: string;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string | undefined;
  error?: string | undefined;
  resultSummary?: string | undefined;
  artifacts?: Artifact[] | undefined;
  conversationId: string;
  origin: ChannelAddress;
}

export type TaskRecord = Omit<TaskSummary, "conversationId"> & {
  messageIds: string[];
  metadata?: Record<string, unknown> | undefined;
  profile: WorkerProfile;
  version: number;
  result?: WorkerResult | undefined;
};

interface WorkerEventBase {
  taskId: string;
  runId: string;
  workerId: string;
  sequence: number;
  emittedAt: string;
  conversationId?: string | undefined;
}

export type WorkerEvent =
  | (WorkerEventBase & { type: "status"; status: TaskStatus; message?: string | undefined })
  | (WorkerEventBase & {
      type: "progress";
      message: string;
      progress?: number | undefined;
    })
  | (WorkerEventBase & { type: "output"; stream: "content" | "reasoning"; delta: string })
  | (WorkerEventBase & { type: "result"; result: WorkerResult })
  | (WorkerEventBase & {
      type: "error";
      error: { message: string; code?: string | undefined; retryable?: boolean | undefined };
    });

export type MonitorEntry =
  | { id: string; kind: "task"; at: string; status: TaskStatus; attempt: number }
  | {
      id: string;
      kind: "status";
      at: string;
      status: TaskStatus;
      message?: string | undefined;
    }
  | {
      id: string;
      kind: "progress";
      at: string;
      message: string;
      progress?: number | undefined;
    }
  | {
      id: string;
      kind: "output";
      at: string;
      stream: "content" | "reasoning";
      content: string;
      chunks: number;
    }
  | { id: string; kind: "result"; at: string; summary: string; artifactCount: number }
  | {
      id: string;
      kind: "error";
      at: string;
      message: string;
      retryable?: boolean | undefined;
    };

export interface TaskDetail {
  task: TaskRecord;
  events: MonitorEntry[];
}

export interface TaskStats {
  total: number;
  queued: number;
  retry_wait: number;
  running: number;
  cancel_requested: number;
  succeeded: number;
  failed: number;
  cancelled: number;
}

export interface WorkerInfo {
  id: string;
  description: string;
  capabilities: string[];
  model: string;
  outputFormat: WorkerOutputFormat;
}

export interface AppStatus {
  state: AppRunState;
  startedAt?: string | undefined;
  configPath: string;
  configWarnings: string[];
  issues: string[];
  model: {
    format: ApiFormat;
    model: string;
    routerModel: string;
    configured: boolean;
  };
  workers: WorkerInfo[];
  channels: string[];
  webhooks: { channel: "github" | "gitlab"; path: string; active: boolean }[];
  stats: TaskStats;
  lastError?: string | undefined;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: string;
  taskId?: string | undefined;
  sourceId?: string | undefined;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage: string;
  activeTasks?: number | undefined;
}

export interface ConversationView {
  conversation: Conversation;
  activeTasks: TaskSummary[];
}

export interface OutboundMessage extends ChannelAddress {
  id: string;
  content: string;
  taskId?: string | undefined;
  inReplyTo?: string | undefined;
  sentAt: string;
}

export interface ModelSettings {
  format: ApiFormat;
  apiKey: string;
  baseUrl: string;
  model: string;
  routerModel: string;
  defaultTemperature: number;
  defaultTopP: number;
}

export interface RouterSettings {
  defaultWorkerId: string;
  defaultMaxAttempts: number;
  retryDelayMs: number;
  notifyProgress: boolean;
  useLlmForWorkerEvents: boolean;
  plannerTimeoutMs: number;
  batchIntervalMs: number;
  maxBatchSize: number;
  maxConcurrentTasks: number;
  stopTimeoutMs: number;
  outboxRetryMs: number;
  rules: Record<string, unknown>[];
}

export interface WorkerSettings {
  id: string;
  description: string;
  capabilities: string[];
  model: string;
  reasoningEffort: "" | ReasoningEffort;
  outputFormat: WorkerOutputFormat;
  systemPrompt: string;
  tools: { allow: string[]; deny: string[] };
  memory: MemoryPolicy;
  generation: { temperature: number | null; topP: number | null; maxTokens: number | null };
}

export interface IntegrationSettings {
  github: { enabled: boolean; token: string; webhookSecret: string; apiBaseUrl: string };
  gitlab: { enabled: boolean; token: string; webhookToken: string; apiBaseUrl: string };
  notion: {
    enabled: boolean;
    token: string;
    databaseId: string;
    pollIntervalMs: number;
    initialCursor: string;
    cursorPath: string;
  };
}

export interface McpServerSetting {
  name: string;
  transport: "stdio" | "http" | "https";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
}

export interface AppConfig {
  version: 1;
  model: ModelSettings;
  router: RouterSettings;
  workers: WorkerSettings[];
  integrations: IntegrationSettings;
  data: {
    hostStatePath: string;
    memoryPath: string;
    skillsPath: string;
    memoryLimit: number;
    maxMemories: number;
    mcpServers: McpServerSetting[];
  };
}

export const SECRET_PATHS = [
  "model.apiKey",
  "integrations.github.token",
  "integrations.github.webhookSecret",
  "integrations.gitlab.token",
  "integrations.gitlab.webhookToken",
  "integrations.notion.token",
] as const;
export type SecretPath = (typeof SECRET_PATHS)[number];
export interface SecretState {
  set: boolean;
  hint: string;
}
export type SecretStatus = Partial<Record<SecretPath, SecretState>>;

export interface BootstrapData {
  app: AppStatus;
  config: AppConfig;
  secretStatus: SecretStatus;
  conversations: ConversationSummary[];
  tasks: TaskSummary[];
  server: { now: string };
}

export interface ConfigResult {
  config: AppConfig;
  secretStatus: SecretStatus;
  status: AppStatus;
}

export interface ApplyConfigResult extends ConfigResult {
  warnings: string[];
}

export interface ValidationResult {
  errors: string[];
  warnings: string[];
  issues: string[];
}

export interface ApiErrorPayload {
  error?: string;
  errors?: string[];
  warnings?: string[];
  details?: { issues?: string[] };
  [key: string]: unknown;
}

export type ViewName = "chat" | "monitor" | "settings";

export const ACTIVE_TASK_STATUSES: TaskStatus[] = [
  "queued",
  "retry_wait",
  "running",
  "cancel_requested",
];

export function isActiveStatus(status: TaskStatus): boolean {
  return ACTIVE_TASK_STATUSES.includes(status);
}
