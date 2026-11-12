import type { TaskRecord, TaskStatus, WorkerEvent } from "@aura/protocol";

export type MonitorEntry =
  | {
      id: string;
      kind: "task";
      at: string;
      status: TaskRecord["status"];
      attempt: number;
    }
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
  | {
      id: string;
      kind: "result";
      at: string;
      summary: string;
      artifactCount: number;
    }
  | {
      id: string;
      kind: "error";
      at: string;
      message: string;
      retryable?: boolean | undefined;
    };

/** 内存态 worker 监控时间线；任务权威状态仍来自 Host 持久化记录。 */
export class MonitorStore {
  private readonly entries = new Map<string, MonitorEntry[]>();

  constructor(private readonly maxEntriesPerTask = 200) {}

  recordTask(task: TaskRecord): void {
    const key = `${task.runId}:${task.status}:${task.attempt}`;
    const list = this.entries.get(task.id) ?? [];
    if (list.some((entry) => entry.kind === "task" && entry.id === key)) return;
    this.push(task.id, {
      id: key,
      kind: "task",
      at: task.updatedAt,
      status: task.status,
      attempt: task.attempt,
    });
  }

  recordEvent(event: WorkerEvent): void {
    if (event.type === "output") {
      const key = `${event.runId}:output:${event.stream}`;
      const list = this.entries.get(event.taskId) ?? [];
      const existing = list.find(
        (entry): entry is Extract<MonitorEntry, { kind: "output" }> =>
          entry.kind === "output" && entry.id === key
      );
      if (existing) {
        existing.content += event.delta;
        existing.at = event.emittedAt;
        existing.chunks += 1;
        return;
      }
      this.push(event.taskId, {
        id: key,
        kind: "output",
        at: event.emittedAt,
        stream: event.stream,
        content: event.delta,
        chunks: 1,
      });
      return;
    }

    const list = this.entries.get(event.taskId) ?? [];
    if (event.type === "status") {
      const key = `${event.runId}:status:${event.status}:${event.message ?? ""}`;
      if (list.some((entry) => entry.kind === "status" && entry.id === key)) return;
      this.push(event.taskId, {
        id: key,
        kind: "status",
        at: event.emittedAt,
        status: event.status,
        ...(event.message !== undefined ? { message: event.message } : {}),
      });
      return;
    }
    if (event.type === "progress") {
      this.push(event.taskId, {
        id: `${event.runId}:progress:${event.sequence}`,
        kind: "progress",
        at: event.emittedAt,
        message: event.message,
        ...(event.progress !== undefined ? { progress: event.progress } : {}),
      });
      return;
    }
    if (event.type === "result") {
      const key = `${event.runId}:result`;
      if (list.some((entry) => entry.kind === "result" && entry.id === key)) return;
      this.push(event.taskId, {
        id: key,
        kind: "result",
        at: event.emittedAt,
        summary: event.result.summary,
        artifactCount: event.result.artifacts?.length ?? 0,
      });
      return;
    }
    this.push(event.taskId, {
      id: `${event.runId}:error:${event.sequence}`,
      kind: "error",
      at: event.emittedAt,
      message: event.error.message,
      ...(event.error.retryable !== undefined ? { retryable: event.error.retryable } : {}),
    });
  }

  events(taskId: string): MonitorEntry[] {
    return structuredClone(this.entries.get(taskId) ?? []);
  }

  /** 仅保留仍然存在的任务，避免长时间运行时无界增长。 */
  prune(taskIds: Set<string>): void {
    for (const taskId of this.entries.keys()) {
      if (!taskIds.has(taskId)) this.entries.delete(taskId);
    }
  }

  clear(): void {
    this.entries.clear();
  }

  private push(taskId: string, entry: MonitorEntry): void {
    const list = this.entries.get(taskId) ?? [];
    list.push(entry);
    if (list.length > this.maxEntriesPerTask) {
      list.splice(0, list.length - this.maxEntriesPerTask);
    }
    this.entries.set(taskId, list);
  }
}
