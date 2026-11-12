import type {
  InboundMessage,
  MessageKind,
  TaskRecord,
  WorkerEvent,
  WorkerProfile,
} from "@aura/protocol";

export interface DispatchDecision {
  type: "dispatch";
  messageId: string;
  workerId?: string | undefined;
  requiredCapabilities?: string[] | undefined;
  input?: string | undefined;
  priority?: number | undefined;
  maxAttempts?: number | undefined;
}

export interface ReplyDecision {
  type: "reply";
  messageId: string;
  content: string;
}

export interface IgnoreDecision {
  type: "ignore";
  messageId: string;
  reason?: string | undefined;
}

export interface CancelDecision {
  type: "cancel";
  messageId: string;
  taskId: string;
  content?: string | undefined;
}

export type RouteDecision = DispatchDecision | ReplyDecision | IgnoreDecision | CancelDecision;

export interface RouteRule {
  name: string;
  priority?: number | undefined;
  match: {
    channel?: string | undefined;
    kind?: MessageKind | undefined;
    senderId?: string | undefined;
    pattern?: string | undefined;
    flags?: string | undefined;
  };
  decision:
    | Omit<DispatchDecision, "messageId">
    | Omit<ReplyDecision, "messageId">
    | Omit<IgnoreDecision, "messageId">;
}

export interface MessageBatch {
  messages: InboundMessage[];
  workers: WorkerProfile[];
  tasks: TaskRecord[];
}

export interface WorkerEventBatch {
  events: WorkerEvent[];
  tasks: TaskRecord[];
  workers: WorkerProfile[];
}

export interface WaitAction {
  type: "wait";
  taskId: string;
  reason?: string | undefined;
}

export interface RetryAction {
  type: "retry";
  taskId: string;
  delayMs?: number | undefined;
  reason?: string | undefined;
}

export interface ReplyAction {
  type: "reply";
  taskId: string;
  content?: string | undefined;
}

export interface FailAction {
  type: "fail";
  taskId: string;
  reason: string;
  notify?: boolean | undefined;
}

export interface CancelAction {
  type: "cancel";
  taskId: string;
  reason?: string | undefined;
}

export interface NotifyAction {
  type: "notify";
  taskId: string;
  content: string;
}

export type WorkerAction =
  | WaitAction
  | RetryAction
  | ReplyAction
  | FailAction
  | CancelAction
  | NotifyAction;

export interface RouterPlanner {
  planMessages?(batch: MessageBatch): Promise<RouteDecision[]>;
  planWorkerEvents?(batch: WorkerEventBatch): Promise<WorkerAction[]>;
}

export interface RouterConfig {
  rules?: RouteRule[] | undefined;
  planner?: RouterPlanner | undefined;
  defaultWorkerId?: string | undefined;
  defaultMaxAttempts?: number | undefined;
  retryDelayMs?: number | undefined;
  notifyProgress?: boolean | undefined;
  useLlmForWorkerEvents?: boolean | undefined;
}

export interface Router {
  routeMessages(batch: MessageBatch): Promise<RouteDecision[]>;
  routeWorkerEvents(batch: WorkerEventBatch): Promise<WorkerAction[]>;
}
