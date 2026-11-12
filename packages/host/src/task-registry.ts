import type { TaskRecord, WorkerEvent } from "@aura/protocol";
import { Task, type NewTask, type TaskChangeListener } from "./task.js";

/** 任务集合与查询边界；任务对象之外不能取得可变的 TaskRecord。 */
export class TaskRegistry {
  private readonly tasks = new Map<string, Task>();

  constructor(private readonly onChange: TaskChangeListener) {}

  restore(records: TaskRecord[]): void {
    this.tasks.clear();
    for (const record of records) {
      const task = Task.restore(record, this.onChange);
      this.tasks.set(task.id, task);
    }
  }

  create(input: NewTask): Task {
    const task = Task.create(input, this.onChange);
    this.tasks.set(task.id, task);
    this.onChange(task.snapshot());
    return task;
  }

  get(taskId: string): Task | undefined {
    return this.tasks.get(taskId);
  }

  values(): Task[] {
    return [...this.tasks.values()];
  }

  getSnapshot(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)?.snapshot();
  }

  snapshots(): TaskRecord[] {
    return this.values().map((task) => task.snapshot());
  }

  ready(now: number): Task[] {
    return this.values()
      .filter((task) => task.isReady(now))
      .sort(
        (left, right) =>
          right.priority - left.priority || left.createdAt.localeCompare(right.createdAt)
      );
  }

  nextRetryAt(): string | undefined {
    return this.values()
      .filter((task) => task.status === "retry_wait" && task.nextAttemptAt)
      .map((task) => task.nextAttemptAt!)
      .sort((left, right) => left.localeCompare(right))[0];
  }

  recover(): WorkerEvent[] {
    const events: WorkerEvent[] = [];
    for (const task of this.tasks.values()) {
      const event = task.recover();
      if (event) events.push(event);
    }
    return events;
  }
}
