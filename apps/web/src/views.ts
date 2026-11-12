import type {
  Artifact,
  ChannelAddress,
  TaskRecord,
  TaskStatus,
  WorkerProfile,
} from "@aura/protocol";
import type { ApiFormat } from "./config.js";

export type AppRunState = "starting" | "running" | "applying" | "error" | "stopped";

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

export interface WorkerInfo {
  id: string;
  description: string;
  capabilities: string[];
  model: string;
  outputFormat: WorkerProfile["outputFormat"];
}

export interface WebhookInfo {
  channel: "github" | "gitlab";
  path: string;
  active: boolean;
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
  webhooks: WebhookInfo[];
  stats: TaskStats;
  lastError?: string | undefined;
}

export function summarizeTask(task: TaskRecord): TaskSummary {
  return {
    id: task.id,
    runId: task.runId,
    workerId: task.workerId,
    status: task.status,
    attempt: task.attempt,
    attempts: task.attempts,
    maxAttempts: task.maxAttempts,
    priority: task.priority,
    input: task.input,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    ...(task.nextAttemptAt !== undefined ? { nextAttemptAt: task.nextAttemptAt } : {}),
    ...(task.error !== undefined ? { error: task.error } : {}),
    ...(task.result?.summary !== undefined
      ? { resultSummary: task.result.summary.slice(0, 500) }
      : {}),
    ...(task.result?.artifacts !== undefined ? { artifacts: task.result.artifacts } : {}),
    conversationId: task.origin.conversationId,
    origin: task.origin,
  };
}

export function taskStats(tasks: TaskRecord[]): TaskStats {
  const stats: TaskStats = {
    total: tasks.length,
    queued: 0,
    retry_wait: 0,
    running: 0,
    cancel_requested: 0,
    succeeded: 0,
    failed: 0,
    cancelled: 0,
  };
  for (const task of tasks) stats[task.status] += 1;
  return stats;
}

export const ACTIVE_TASK_STATUSES: TaskStatus[] = [
  "queued",
  "retry_wait",
  "running",
  "cancel_requested",
];
