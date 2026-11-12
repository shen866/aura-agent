import { describe, expect, it } from "vitest";
import type { WorkerProfile } from "@aura/protocol";
import { Task, type NewTask } from "../task.js";

const profile: WorkerProfile = {
  id: "worker",
  description: "test worker",
  capabilities: ["test"],
  outputFormat: "text",
  tools: {},
  memory: { read: false, write: false },
};

const newTask: NewTask = {
  input: "input",
  messageIds: ["message"],
  origin: { channel: "memory", conversationId: "conversation" },
  workerId: "worker",
  priority: 0,
  maxAttempts: 2,
  profile,
};

function createTask(): Task {
  return Task.create(newTask, () => undefined);
}

describe("Task", () => {
  it("只有当前 runId 可以提交结果，终态任务不能重新执行", () => {
    const task = createTask();
    task.start("run-current");

    expect(task.complete("run-stale", { summary: "stale" })).toBeUndefined();
    expect(task.status).toBe("running");

    const event = task.complete("run-current", { summary: "done" });
    expect(event?.type).toBe("result");
    expect(task.status).toBe("succeeded");
    expect(task.snapshot().result?.summary).toBe("done");
    expect(() => task.start("run-next")).toThrow("不能执行");
  });

  it("运行中取消先请求 abort，随后由本次运行提交取消终态", () => {
    const task = createTask();
    task.start("run-1");

    expect(task.requestCancel("user cancel")).toEqual({ accepted: true, action: "abort" });
    expect(task.status).toBe("cancel_requested");

    const event = task.fail("run-1", new Error("aborted"), true);
    expect(event).toMatchObject({ type: "status", status: "cancelled" });
    expect(task.status).toBe("cancelled");
  });

  it("只有未耗尽次数的失败任务可以重试", () => {
    const task = createTask();
    task.start("run-1");
    task.fail("run-1", new Error("temporary"));

    expect(task.scheduleRetry(0, "retry")).toBe(true);
    expect(task.status).toBe("retry_wait");
    expect(task.nextAttemptAt).toBeDefined();

    task.start("run-2");
    expect(task.snapshot().attempts).toBe(2);
    task.fail("run-2", new Error("permanent"));
    expect(task.scheduleRetry(0)).toBe(false);
    expect(task.requestCancel("too late")).toEqual({ accepted: false });
  });
});
