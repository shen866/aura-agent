import { createId, type Worker, type WorkerEvent, type WorkerProfile } from "@aura/protocol";
import type { TaskRegistry } from "./task-registry.js";
import type { Task } from "./task.js";

interface RunningTask {
  controller: AbortController;
  done: Promise<void>;
}

export interface TaskDispatcherOptions {
  tasks: TaskRegistry;
  workers: ReadonlyMap<string, { worker: Worker; profile: WorkerProfile }>;
  maxConcurrentTasks: number;
  stopTimeoutMs: number;
  commit: () => Promise<void>;
  queueTerminalEvent: (event: WorkerEvent) => void;
}

/** 执行资源边界：并发调度、worker 调用、运行取消和重试定时器。 */
export class TaskDispatcher {
  private readonly running = new Map<string, RunningTask>();
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private accepting = false;

  constructor(private readonly options: TaskDispatcherOptions) {}

  start(): void {
    this.accepting = true;
    this.pump();
  }

  pause(): void {
    this.accepting = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  hasRunning(): boolean {
    return this.running.size > 0;
  }

  async cancel(taskId: string, reason: string): Promise<boolean> {
    const task = this.options.tasks.get(taskId);
    if (!task) return false;
    const plan = task.requestCancel(reason);
    if (!plan.accepted) return false;

    await this.options.commit();
    if (plan.action === "abort") {
      this.running.get(taskId)?.controller.abort(new Error(reason));
    } else {
      this.options.queueTerminalEvent(plan.event);
    }
    return true;
  }

  /** 等待当前活动执行及其接续 dispatch 全部离开 running，不等待未来的重试定时器。 */
  async idle(): Promise<void> {
    while (this.running.size > 0) {
      await Promise.all([...this.running.values()].map((item) => item.done));
    }
  }

  async waitForRunning(): Promise<boolean> {
    const running = [...this.running.values()].map((item) => item.done);
    if (running.length === 0) return false;

    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.all(running),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, this.options.stopTimeoutMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    return timedOut;
  }

  pump(): void {
    if (!this.accepting) return;
    const capacity = this.options.maxConcurrentTasks - this.running.size;
    if (capacity <= 0) return;

    const ready = this.options.tasks.ready(Date.now());
    for (const task of ready.slice(0, capacity)) {
      const controller = new AbortController();
      task.start(createId("run"));
      const done = this.execute(task, controller);
      this.running.set(task.id, { controller, done });
      void done.finally(() => {
        this.running.delete(task.id);
        this.pump();
      });
    }

    const nextAttemptAt = this.options.tasks.nextRetryAt();
    if (nextAttemptAt) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(
        () => {
          this.retryTimer = undefined;
          this.pump();
        },
        Math.max(0, new Date(nextAttemptAt).getTime() - Date.now())
      );
      this.retryTimer.unref?.();
    }
  }

  private async execute(task: Task, controller: AbortController): Promise<void> {
    const runId = task.runId;
    await this.options.commit();
    const registration = this.options.workers.get(task.workerId);
    if (!registration) {
      const event = task.fail(runId, new Error(`worker ${task.workerId} 未注册`));
      if (event) {
        await this.options.commit();
        this.options.queueTerminalEvent(event);
      }
      return;
    }

    try {
      const snapshot = task.snapshot();
      const result = await registration.worker.run(snapshot, {
        signal: controller.signal,
        profile: structuredClone(snapshot.profile),
      });
      const event = task.complete(runId, result);
      if (!event) return;
      await this.options.commit();
      this.options.queueTerminalEvent(event);
    } catch (error) {
      const event = task.fail(runId, error, controller.signal.aborted);
      if (!event) return;
      await this.options.commit();
      this.options.queueTerminalEvent(event);
    }
  }
}
