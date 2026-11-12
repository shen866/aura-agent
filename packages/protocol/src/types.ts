export type Metadata = Record<string, unknown>;

export type MessageKind =
  | "message"
  | "command"
  | "issue"
  | "pull_request"
  | "merge_request"
  | "page";

/** 回复所需的渠道地址，不包含任务执行状态。 */
export interface ChannelAddress {
  channel: string;
  conversationId: string;
  recipientId?: string | undefined;
  metadata?: Metadata | undefined;
}

export interface InboundMessage extends ChannelAddress {
  id: string;
  senderId: string;
  content: string;
  kind: MessageKind;
  receivedAt: string;
  correlationId?: string | undefined;
  /** 渠道侧事件 ID，用于 webhook 重投去重。 */
  externalId?: string | undefined;
}

export interface OutboundMessage extends ChannelAddress {
  /** 同时作为渠道发送的幂等键。 */
  id: string;
  content: string;
  taskId?: string | undefined;
  inReplyTo?: string | undefined;
  sentAt: string;
}

export type TaskStatus =
  | "queued"
  | "retry_wait"
  | "running"
  | "cancel_requested"
  | "succeeded"
  | "failed"
  | "cancelled";

export interface Artifact {
  type: string;
  name: string;
  uri?: string | undefined;
  content?: string | undefined;
  metadata?: Metadata | undefined;
}

/** 所有 worker 都必须返回的统一结构。 */
export interface WorkerResult {
  summary: string;
  data?: unknown;
  artifacts?: Artifact[] | undefined;
  raw?: string | undefined;
}

export interface WorkerTask {
  id: string;
  /** 每次 dispatch（包括重试）都有新 ID，用于隔离迟到事件。 */
  runId: string;
  input: string;
  messageIds: string[];
  origin: ChannelAddress;
  attempt: number;
  metadata?: Metadata | undefined;
}

export interface TaskRecord extends WorkerTask {
  /** 已发起的执行次数；attempt 是当前执行序号。 */
  attempts: number;
  workerId: string;
  status: TaskStatus;
  priority: number;
  maxAttempts: number;
  /** 创建任务时的不可变配置快照。 */
  profile: WorkerProfile;
  createdAt: string;
  updatedAt: string;
  nextAttemptAt?: string | undefined;
  /** 持久化状态版本，每次状态迁移递增。 */
  version: number;
  result?: WorkerResult | undefined;
  error?: string | undefined;
}

export interface ToolPolicy {
  /** 未设置表示允许全部工具；设置后仅允许白名单中的工具。 */
  allow?: string[] | undefined;
  /** 黑名单优先于白名单。 */
  deny?: string[] | undefined;
}

export interface MemoryPolicy {
  read: boolean;
  write: boolean;
}

export type ReasoningEffort = "low" | "medium" | "high";
export type WorkerOutputFormat = "text" | "json";

/** host 注入给 worker 的每次运行配置。 */
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

export interface WorkerRunOptions {
  signal?: AbortSignal | undefined;
  profile?: WorkerProfile | undefined;
}

interface WorkerEventBase {
  taskId: string;
  runId: string;
  workerId: string;
  sequence: number;
  emittedAt: string;
}

export interface WorkerStatusEvent extends WorkerEventBase {
  type: "status";
  status: TaskStatus;
  message?: string | undefined;
}

export interface WorkerProgressEvent extends WorkerEventBase {
  type: "progress";
  message: string;
  progress?: number | undefined;
}

export interface WorkerOutputEvent extends WorkerEventBase {
  type: "output";
  stream: "content" | "reasoning";
  delta: string;
}

export interface WorkerResultEvent extends WorkerEventBase {
  type: "result";
  result: WorkerResult;
}

export interface WorkerErrorEvent extends WorkerEventBase {
  type: "error";
  error: {
    message: string;
    code?: string | undefined;
    retryable?: boolean | undefined;
  };
}

export type WorkerEvent =
  | WorkerStatusEvent
  | WorkerProgressEvent
  | WorkerOutputEvent
  | WorkerResultEvent
  | WorkerErrorEvent;

export type WorkerEventListener = (event: WorkerEvent) => void;
export type Unsubscribe = () => void;

/** host 面向不同 worker 实现依赖的唯一执行协议。 */
export interface Worker {
  readonly id: string;
  run(task: WorkerTask, options?: WorkerRunOptions): Promise<WorkerResult>;
  subscribe(listener: WorkerEventListener): Unsubscribe;
}
