import {
  createId,
  type ChannelAddress,
  type Metadata,
  type TaskRecord,
  type WorkerEvent,
  type WorkerProfile,
  type WorkerResult,
} from "@aura/protocol";

export interface NewTask {
  input: string;
  messageIds: string[];
  origin: ChannelAddress;
  workerId: string;
  priority: number;
  maxAttempts: number;
  profile: WorkerProfile;
  metadata?: Metadata | undefined;
}

export type CancelPlan =
  | { accepted: false }
  | { accepted: true; action: "abort" }
  | { accepted: true; action: "event"; event: WorkerEvent };

export type TaskChangeListener = (task: TaskRecord) => void;

/** 任务聚合：拥有单次任务的状态机和运行不变量，持久化与执行由应用服务协调。 */
export class Task {
  private constructor(
    private readonly record: TaskRecord,
    private readonly onChange: TaskChangeListener
  ) {}

  static create(input: NewTask, onChange: TaskChangeListener): Task {
    const now = new Date().toISOString();
    return new Task(
      {
        id: createId("task"),
        runId: createId("run"),
        input: input.input,
        messageIds: [...input.messageIds],
        origin: structuredClone(input.origin),
        attempt: 0,
        attempts: 0,
        workerId: input.workerId,
        status: "queued",
        priority: input.priority,
        maxAttempts: input.maxAttempts,
        profile: structuredClone(input.profile),
        createdAt: now,
        updatedAt: now,
        version: 0,
        ...(input.metadata !== undefined ? { metadata: structuredClone(input.metadata) } : {}),
      },
      onChange
    );
  }

  static restore(record: TaskRecord, onChange: TaskChangeListener): Task {
    return new Task(structuredClone(record), onChange);
  }

  get id(): string {
    return this.record.id;
  }

  get runId(): string {
    return this.record.runId;
  }

  get workerId(): string {
    return this.record.workerId;
  }

  get status(): TaskRecord["status"] {
    return this.record.status;
  }

  get priority(): number {
    return this.record.priority;
  }

  get createdAt(): string {
    return this.record.createdAt;
  }

  get nextAttemptAt(): string | undefined {
    return this.record.nextAttemptAt;
  }

  snapshot(): TaskRecord {
    return structuredClone(this.record);
  }

  isReady(now: number): boolean {
    return (
      (this.record.status === "queued" || this.record.status === "retry_wait") &&
      (!this.record.nextAttemptAt || new Date(this.record.nextAttemptAt).getTime() <= now)
    );
  }

  /** 崩溃恢复只重建任务级决策，不伪装成 worker 的 ReAct 断点恢复。 */
  recover(now = new Date().toISOString()): WorkerEvent | undefined {
    if (this.record.status === "running" || this.record.status === "cancel_requested") {
      if (this.record.status === "cancel_requested") {
        this.transition("cancelled", "host 重启后确认取消");
      } else if (this.record.attempts < this.record.maxAttempts) {
        this.transition("retry_wait", "host 重启后重新排队");
        this.record.nextAttemptAt = now;
      } else {
        this.transition("failed", "host 重启时任务已耗尽重试次数");
      }
    }
    return this.recoveredTerminalEvent();
  }

  start(runId: string): void {
    if (this.record.status !== "queued" && this.record.status !== "retry_wait") {
      throw new Error(`任务 ${this.record.id} 当前状态 ${this.record.status} 不能执行`);
    }
    this.record.attempts += 1;
    this.record.attempt = this.record.attempts;
    this.record.runId = runId;
    delete this.record.error;
    delete this.record.nextAttemptAt;
    this.transition("running");
  }

  complete(runId: string, result: WorkerResult): WorkerEvent | undefined {
    if (this.record.runId !== runId) return undefined;
    if (this.record.status === "cancel_requested") {
      this.transition("cancelled", "任务已取消");
      return this.statusEvent("cancelled", "任务已取消");
    }
    if (this.record.status !== "running") return undefined;

    this.record.result = structuredClone(result);
    this.transition("succeeded");
    return {
      type: "result",
      ...this.eventBase(),
      result: structuredClone(result),
    };
  }

  fail(runId: string, error: unknown, aborted = false): WorkerEvent | undefined {
    if (
      this.record.runId !== runId ||
      !["running", "cancel_requested"].includes(this.record.status)
    ) {
      return undefined;
    }
    if (this.record.status === "cancel_requested" || aborted) {
      this.transition("cancelled", "任务已取消");
      this.record.error = "任务已取消";
      return this.statusEvent("cancelled", "任务已取消");
    }

    const normalized = error instanceof Error ? error : new Error(String(error));
    this.record.error = normalized.message;
    this.transition("failed", normalized.message);
    return {
      type: "error",
      ...this.eventBase(),
      error: { message: normalized.message, retryable: true },
    };
  }

  requestCancel(reason: string): CancelPlan {
    if (["succeeded", "cancelled"].includes(this.record.status)) return { accepted: false };
    if (
      this.record.status === "failed" &&
      (this.record.attempts >= this.record.maxAttempts ||
        this.record.metadata?.__retryDisabled === true ||
        this.record.metadata?.__notifiedRunId === this.record.runId)
    ) {
      return { accepted: false };
    }

    if (this.record.status === "running") {
      this.transition("cancel_requested", reason);
      return { accepted: true, action: "abort" };
    }

    this.transition("cancelled", reason);
    this.record.error = reason;
    delete this.record.nextAttemptAt;
    return { accepted: true, action: "event", event: this.statusEvent("cancelled", reason) };
  }

  scheduleRetry(requestedDelay: number | undefined, reason?: string): boolean {
    if (this.record.status !== "failed" || this.record.attempts >= this.record.maxAttempts) {
      return false;
    }
    const baseDelay =
      typeof requestedDelay === "number" && Number.isFinite(requestedDelay)
        ? Math.max(0, requestedDelay)
        : 1000;
    const delay = Math.min(baseDelay * 2 ** Math.max(0, this.record.attempts - 1), 2_147_483_647);
    this.record.nextAttemptAt = new Date(Date.now() + delay).toISOString();
    this.transition("retry_wait", reason ?? this.record.error);
    return true;
  }

  acceptsNotification(kind: "reply" | "notify"): boolean {
    const isFinal = kind === "reply";
    const isTerminal = ["succeeded", "failed", "cancelled"].includes(this.record.status);
    return (
      isFinal === isTerminal &&
      (!isFinal || this.record.metadata?.__notifiedRunId !== this.record.runId)
    );
  }

  notificationContent(content?: string): string {
    return (
      content ??
      this.record.result?.summary ??
      (this.record.error ? `任务失败：${this.record.error}` : "任务已完成。")
    );
  }

  markNotified(): void {
    this.record.metadata = { ...this.record.metadata, __notifiedRunId: this.record.runId };
    this.touch();
  }

  failPermanently(reason: string, notified: boolean): void {
    if (this.record.status !== "failed") {
      throw new Error(`任务 ${this.record.id} 当前状态 ${this.record.status} 不能标记为最终失败`);
    }
    this.record.error = reason;
    this.record.metadata = { ...this.record.metadata, __retryDisabled: true };
    if (notified) this.record.metadata.__notifiedRunId = this.record.runId;
    this.touch();
    this.emitChange();
  }

  private recoveredTerminalEvent(): WorkerEvent | undefined {
    if (this.record.metadata?.__notifiedRunId === this.record.runId) return undefined;
    if (this.record.status === "succeeded") {
      return {
        type: "result",
        ...this.eventBase(),
        result: this.record.result ?? { summary: "任务已完成。" },
      };
    }
    if (this.record.status === "cancelled") {
      return this.statusEvent("cancelled", this.record.error ?? "任务已取消");
    }
    if (this.record.status === "failed" && this.record.metadata?.__retryDisabled !== true) {
      return {
        type: "error",
        ...this.eventBase(),
        error: {
          message: this.record.error ?? "worker 执行失败",
          retryable: this.record.attempts < this.record.maxAttempts,
        },
      };
    }
    return undefined;
  }

  private statusEvent(status: TaskRecord["status"], message: string): WorkerEvent {
    return {
      type: "status",
      ...this.eventBase(),
      status,
      message,
    };
  }

  private eventBase(): Pick<
    WorkerEvent,
    "taskId" | "runId" | "workerId" | "sequence" | "emittedAt"
  > {
    return {
      taskId: this.record.id,
      runId: this.record.runId,
      workerId: this.record.workerId,
      sequence: Number.MAX_SAFE_INTEGER,
      emittedAt: new Date().toISOString(),
    };
  }

  private transition(status: TaskRecord["status"], error?: string): void {
    this.record.status = status;
    if (error !== undefined) this.record.error = error;
    this.touch();
    this.emitChange();
  }

  private touch(): void {
    this.record.updatedAt = new Date().toISOString();
    this.record.version += 1;
  }

  private emitChange(): void {
    this.onChange(this.snapshot());
  }
}
