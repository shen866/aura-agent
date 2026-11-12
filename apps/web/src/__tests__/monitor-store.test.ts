import { describe, expect, it } from "vitest";
import type { TaskRecord, WorkerEvent } from "@aura/protocol";
import { MonitorStore } from "../monitor-store.js";

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: "task-1",
    runId: "run-1",
    input: "input",
    messageIds: ["message-1"],
    origin: { channel: "web", conversationId: "conv-1" },
    attempt: 1,
    attempts: 1,
    workerId: "worker",
    status: "running",
    priority: 0,
    maxAttempts: 2,
    profile: {
      id: "worker",
      description: "worker",
      capabilities: [],
      outputFormat: "text",
      tools: {},
      memory: { read: true, write: true },
    },
    createdAt: now,
    updatedAt: now,
    version: 1,
    ...overrides,
  };
}

function event(overrides: Partial<WorkerEvent>): WorkerEvent {
  return {
    type: "progress",
    taskId: "task-1",
    runId: "run-1",
    workerId: "worker",
    sequence: 1,
    emittedAt: new Date().toISOString(),
    message: "working",
    ...overrides,
  } as WorkerEvent;
}

describe("MonitorStore", () => {
  it("aggregates streaming output per run and stream", () => {
    const store = new MonitorStore();
    store.recordEvent(event({ type: "output", stream: "content", delta: "hello ", sequence: 1 }));
    store.recordEvent(event({ type: "output", stream: "content", delta: "world", sequence: 2 }));
    store.recordEvent(
      event({ type: "output", stream: "reasoning", delta: "thinking", sequence: 3 })
    );
    const entries = store.events("task-1");
    const outputs = entries.filter((entry) => entry.kind === "output");
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({ stream: "content", content: "hello world", chunks: 2 });
  });

  it("deduplicates task status and worker status entries", () => {
    const store = new MonitorStore();
    store.recordTask(task({ status: "queued", attempt: 0 }));
    store.recordTask(task({ status: "running" }));
    store.recordTask(task({ status: "running" }));
    store.recordEvent(event({ type: "status", status: "running", message: "第 1 次执行" }));
    store.recordEvent(event({ type: "status", status: "running", message: "第 1 次执行" }));
    const entries = store.events("task-1");
    expect(entries.filter((entry) => entry.kind === "task")).toHaveLength(2);
    expect(entries.filter((entry) => entry.kind === "status")).toHaveLength(1);
  });

  it("bounds entries per task and prunes removed tasks", () => {
    const store = new MonitorStore(5);
    for (let index = 0; index < 12; index += 1) {
      store.recordEvent(event({ sequence: index, message: `progress-${index}` }));
    }
    expect(store.events("task-1")).toHaveLength(5);
    store.prune(new Set(["other"]));
    expect(store.events("task-1")).toEqual([]);
  });
});
