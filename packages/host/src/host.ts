import type {
  InboundMessage,
  OutboundMessage,
  TaskRecord,
  Worker,
  WorkerEvent,
  WorkerProfile,
} from "@aura/protocol";
import type { Router } from "@aura/router";
import { BatchQueue } from "./batch-queue.js";
import type { Channel } from "./channel.js";
import { MessageIntake } from "./message-intake.js";
import { Outbox } from "./outbox.js";
import { HostStateCommitter } from "./state-committer.js";
import type { HostStore } from "./store.js";
import { TaskDispatcher } from "./task-dispatcher.js";
import { TaskRegistry } from "./task-registry.js";

export interface HostOptions {
  router: Router;
  store?: HostStore | undefined;
  batchIntervalMs?: number | undefined;
  maxBatchSize?: number | undefined;
  maxConcurrentTasks?: number | undefined;
  outboxRetryMs?: number | undefined;
  /** 等待忽略 abort 的自定义 worker 的最长时间，超时后保留 cancel_requested 供恢复。 */
  stopTimeoutMs?: number | undefined;
}

export type HostEvent =
  | { type: "message.accepted"; message: InboundMessage }
  | { type: "task.updated"; task: TaskRecord }
  | { type: "message.sent"; message: OutboundMessage }
  /** worker 的瞬时事件，供监控视图展示流式输出；权威终态仍以 run() Promise 为准。 */
  | { type: "worker.event"; event: WorkerEvent }
  | { type: "error"; error: Error };

export type HostEventListener = (event: HostEvent) => void;

/** Host 是控制面门面；任务、调度、输入、输出和持久化分别由内部对象维护。 */
export class Host {
  private readonly router: Router;
  private readonly channels = new Map<string, Channel>();
  private readonly workers = new Map<string, { worker: Worker; profile: WorkerProfile }>();
  private readonly workerUnsubscribers = new Map<string, () => void>();
  private readonly tasks: TaskRegistry;
  private readonly dispatcher: TaskDispatcher;
  private readonly intake: MessageIntake;
  private readonly outbox: Outbox;
  private readonly state: HostStateCommitter;
  private readonly listeners = new Set<HostEventListener>();
  private readonly processedWorkerEvents = new Set<string>();
  private readonly workerEventQueue: BatchQueue<WorkerEvent>;
  private started = false;
  private accepting = false;

  constructor(options: HostOptions) {
    this.router = options.router;
    const onError = (error: Error) => this.emit({ type: "error", error });
    this.tasks = new TaskRegistry((task) => this.emit({ type: "task.updated", task }));
    this.workerEventQueue = new BatchQueue({
      maxWaitMs: options.batchIntervalMs ?? 300,
      maxBatchSize: options.maxBatchSize ?? 50,
      process: (batch) => this.processWorkerEventBatch(batch),
      onError,
    });
    this.state = new HostStateCommitter({
      store: options.store,
      snapshot: () => ({
        tasks: this.tasks.snapshots(),
        inbox: this.intake.snapshot(),
        outbox: this.outbox.snapshot(),
        processedMessageKeys: this.intake.processedSnapshot(),
      }),
      onError,
    });
    this.intake = new MessageIntake({
      maxWaitMs: options.batchIntervalMs ?? 300,
      maxBatchSize: options.maxBatchSize ?? 20,
      process: (batch) => this.processMessageBatch(batch),
      commit: () => this.state.commit(),
      onAccepted: (message) => this.emit({ type: "message.accepted", message }),
      onError,
    });
    this.outbox = new Outbox({
      retryMs: options.outboxRetryMs ?? 2000,
      getChannel: (channelId) => this.channels.get(channelId),
      isStarted: () => this.started,
      commit: () => this.state.commit(),
      onSent: (message) => this.emit({ type: "message.sent", message }),
      onError,
    });
    this.dispatcher = new TaskDispatcher({
      tasks: this.tasks,
      workers: this.workers,
      maxConcurrentTasks: options.maxConcurrentTasks ?? 4,
      stopTimeoutMs: options.stopTimeoutMs ?? 5000,
      commit: () => this.state.commit(),
      queueTerminalEvent: (event) => this.queueTerminalEvent(event),
    });
  }

  registerChannel(channel: Channel): void {
    if (this.channels.has(channel.id)) throw new Error(`重复 channel：${channel.id}`);
    this.channels.set(channel.id, channel);
  }

  registerWorker(worker: Worker, profile: WorkerProfile): void {
    if (worker.id !== profile.id) throw new Error("worker.id 必须与 profile.id 一致");
    if (this.workers.has(worker.id)) throw new Error(`重复 worker：${worker.id}`);
    this.workers.set(worker.id, { worker, profile: structuredClone(profile) });
  }

  subscribe(listener: HostEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async start(): Promise<void> {
    if (this.started) return;
    if (this.dispatcher.hasRunning()) {
      throw new Error("仍有旧 worker 未结束，请等待或创建新的 Host 实例");
    }

    const persisted = await this.state.read();
    this.tasks.restore(persisted.tasks);
    this.intake.restore(persisted.inbox, persisted.processedMessageKeys);
    this.outbox.restore(persisted.outbox);
    const recoveredTerminalEvents = this.tasks.recover();
    await this.state.commit();

    this.intake.reopen();
    this.workerEventQueue.reopen();
    this.started = true;
    this.accepting = true;
    for (const { worker } of this.workers.values()) {
      this.workerUnsubscribers.set(
        worker.id,
        worker.subscribe((event) => this.onWorkerEvent(event))
      );
    }
    for (const channel of this.channels.values()) {
      await channel.start(async (message) => {
        await this.ingest(message);
      });
    }
    for (const event of recoveredTerminalEvents) this.workerEventQueue.push(event);
    this.intake.resume();
    void this.outbox.flush();
    this.dispatcher.start();
  }

  /** 渠道只有在 inbox 持久化完成后才收到 ack（Promise resolve）。 */
  async ingest(message: InboundMessage): Promise<boolean> {
    if (!this.started || !this.accepting) throw new Error("host 尚未启动或正在停止");
    return this.intake.ingest(message);
  }

  async flush(): Promise<void> {
    // 每轮先等待活动执行，再处理其终态事件；立即重试会开启下一轮，未来重试不等待定时器。
    while (true) {
      await Promise.all([this.intake.flush(), this.workerEventQueue.flush()]);
      await this.state.idle();
      await this.dispatcher.idle();
      await this.state.idle();
      await this.workerEventQueue.flush();
      await this.state.idle();
      if (!this.dispatcher.hasRunning()) break;
    }
    await this.outbox.flush();
    this.dispatcher.pump();
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    this.accepting = false;
    this.dispatcher.pause();
    for (const channel of this.channels.values()) await channel.stop?.();
    await this.intake.close();

    const cancellations: Promise<boolean>[] = [];
    for (const task of this.tasks.values()) {
      if (["queued", "retry_wait", "running", "failed"].includes(task.status)) {
        cancellations.push(this.cancelTask(task.id, "host 停止"));
      }
    }
    await Promise.all(cancellations);
    if (await this.dispatcher.waitForRunning()) {
      this.emit({
        type: "error",
        error: new Error("部分 worker 未在停止超时前响应 abort，任务保持 cancel_requested"),
      });
    }
    await this.workerEventQueue.close();
    await this.state.idle();
    await this.outbox.flush();
    this.outbox.stop();

    for (const unsubscribe of this.workerUnsubscribers.values()) unsubscribe();
    this.workerUnsubscribers.clear();
    this.started = false;
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.getSnapshot(taskId);
  }

  listTasks(): TaskRecord[] {
    return this.tasks.snapshots();
  }

  async cancelTask(taskId: string, reason = "用户取消"): Promise<boolean> {
    return this.dispatcher.cancel(taskId, reason);
  }

  private async processMessageBatch(messages: InboundMessage[]): Promise<void> {
    try {
      const decisions = await this.router.routeMessages({
        messages,
        workers: [...this.workers.values()].map(({ profile }) => structuredClone(profile)),
        tasks: this.listTasks(),
      });
      for (const message of messages) {
        const decision = decisions.find((candidate) => candidate.messageId === message.id);
        if (!decision || decision.type === "ignore") continue;
        if (decision.type === "reply") {
          this.outbox.queueMessage(message, decision.content, {
            inReplyTo: message.id,
            idempotencyKey: `message:${message.id}:reply`,
          });
        } else if (decision.type === "cancel") {
          await this.cancelTask(decision.taskId, decision.content ?? "用户请求取消");
          this.outbox.queueMessage(
            message,
            decision.content ?? `已请求取消任务 ${decision.taskId}。`,
            {
              inReplyTo: message.id,
              idempotencyKey: `message:${message.id}:cancel`,
            }
          );
        } else {
          const registration = this.workers.get(decision.workerId ?? "");
          if (!registration) {
            this.outbox.queueMessage(
              message,
              `无法分派：worker ${decision.workerId ?? "(未指定)"} 不存在。`,
              {
                inReplyTo: message.id,
                idempotencyKey: `message:${message.id}:error`,
              }
            );
            continue;
          }
          this.tasks.create({
            input: decision.input ?? message.content,
            messageIds: [message.id],
            origin: {
              channel: message.channel,
              conversationId: message.conversationId,
              ...(message.recipientId !== undefined ? { recipientId: message.recipientId } : {}),
              ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
            },
            workerId: registration.worker.id,
            priority: decision.priority ?? 0,
            maxAttempts: decision.maxAttempts ?? 2,
            profile: structuredClone(registration.profile),
            ...(message.metadata !== undefined ? { metadata: message.metadata } : {}),
          });
        }
      }
      this.intake.complete(messages);
      await this.state.commit();
    } catch (error) {
      // 单批决策异常转成可见错误，避免毒消息无限阻塞整个输入队列。
      for (const message of messages) {
        this.outbox.queueMessage(
          message,
          `任务路由失败：${error instanceof Error ? error.message : String(error)}`,
          { inReplyTo: message.id, idempotencyKey: `message:${message.id}:route-error` }
        );
      }
      this.intake.complete(messages);
      await this.state.commit();
    }
    void this.outbox.flush();
    this.dispatcher.pump();
  }

  private onWorkerEvent(event: WorkerEvent): void {
    const task = this.tasks.get(event.taskId);
    if (!task || task.runId !== event.runId) return;
    // 先广播原始事件，监控/聊天订阅者可展示流式 delta；不改变控制面语义。
    this.emit({ type: "worker.event", event: structuredClone(event) });
    if (task.status !== "running") return;
    // result/error/终态 status 由 run() 的 Promise 统一提交，避免双终态来源。
    if (
      event.type === "result" ||
      event.type === "error" ||
      (event.type === "status" && ["succeeded", "failed", "cancelled"].includes(event.status))
    ) {
      return;
    }
    const key = `${event.runId}:${event.sequence}`;
    if (this.processedWorkerEvents.has(key)) return;
    this.processedWorkerEvents.add(key);
    this.workerEventQueue.push(event);
  }

  private queueTerminalEvent(event: WorkerEvent): void {
    if (!this.started) return;
    try {
      this.workerEventQueue.push(event);
    } catch (error) {
      // stop 超时后，忽略 abort 的 worker 仍可能晚于事件队列关闭才结束。
      if (this.accepting) throw error;
    }
  }

  private async processWorkerEventBatch(events: WorkerEvent[]): Promise<void> {
    const actions = await this.router.routeWorkerEvents({
      events,
      tasks: this.listTasks(),
      workers: [...this.workers.values()].map(({ profile }) => structuredClone(profile)),
    });
    for (const action of actions) {
      const task = this.tasks.get(action.taskId);
      if (!task) continue;
      if (action.type === "wait") continue;
      if (action.type === "retry") {
        if (!task.scheduleRetry(action.delayMs, action.reason)) continue;
        await this.state.commit();
      } else if (action.type === "reply" || action.type === "notify") {
        const kind = action.type;
        if (!task.acceptsNotification(kind)) continue;
        const content = task.notificationContent(action.content);
        this.outbox.queueTask(task.snapshot(), content, kind);
        if (kind === "reply") task.markNotified();
        await this.state.commit();
      } else if (action.type === "fail") {
        if (task.status !== "failed") continue;
        if (action.notify) {
          this.outbox.queueTask(task.snapshot(), `任务失败：${action.reason}`, "reply");
        }
        task.failPermanently(action.reason, action.notify === true);
        await this.state.commit();
      } else if (action.type === "cancel") {
        await this.cancelTask(task.id, action.reason ?? "router 请求取消");
      }
    }
    void this.outbox.flush();
    this.dispatcher.pump();
  }

  private emit(event: HostEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // 渲染器/监控订阅者不能影响控制面。
      }
    }
  }
}
