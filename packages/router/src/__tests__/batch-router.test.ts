import { describe, expect, it, vi } from "vitest";
import type { InboundMessage, TaskRecord, WorkerEvent, WorkerProfile } from "@aura/protocol";
import { BatchRouter } from "../batch-router.js";

const workers: WorkerProfile[] = [
  {
    id: "general",
    description: "general",
    capabilities: ["chat"],
    outputFormat: "text",
    tools: {},
    memory: { read: true, write: true },
  },
  {
    id: "coder",
    description: "coder",
    capabilities: ["code"],
    outputFormat: "json",
    tools: {},
    memory: { read: false, write: false },
  },
];

function message(id: string, content = "hello"): InboundMessage {
  return {
    id,
    content,
    channel: "test",
    conversationId: "c",
    senderId: "u",
    kind: "message",
    receivedAt: new Date().toISOString(),
  };
}

function task(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task-1",
    runId: "run-1",
    input: "work",
    messageIds: ["m1"],
    origin: { channel: "test", conversationId: "c" },
    attempt: 1,
    attempts: 1,
    workerId: "general",
    status: "failed",
    priority: 0,
    maxAttempts: 2,
    profile: workers[0]!,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    ...overrides,
  };
}

function event(overrides: Partial<WorkerEvent> = {}): WorkerEvent {
  return {
    type: "error",
    taskId: "task-1",
    runId: "run-1",
    workerId: "general",
    sequence: 1,
    emittedAt: new Date().toISOString(),
    error: { message: "temporary", retryable: true },
    ...overrides,
  } as WorkerEvent;
}

describe("BatchRouter 输入批次", () => {
  it("规则优先，未命中消息合并给一次 LLM", async () => {
    const planner = {
      planMessages: vi.fn(async ({ messages }: { messages: InboundMessage[] }) =>
        messages.map((item) => ({
          type: "dispatch" as const,
          messageId: item.id,
          workerId: "coder",
        }))
      ),
    };
    const router = new BatchRouter({
      rules: [
        {
          name: "代码规则",
          match: { pattern: "^/code" },
          decision: { type: "dispatch", workerId: "coder" },
        },
      ],
      planner,
    });
    const result = await router.routeMessages({
      messages: [message("m1", "/code fix"), message("m2"), message("m3")],
      workers,
      tasks: [],
    });
    expect(result.map((decision) => decision.type)).toEqual(["dispatch", "dispatch", "dispatch"]);
    expect(planner.planMessages).toHaveBeenCalledOnce();
    expect(
      planner.planMessages.mock.calls[0]?.[0].messages.map((item: InboundMessage) => item.id)
    ).toEqual(["m2", "m3"]);
  });

  it("拒绝 LLM 的未知 worker，并使用确定性 fallback", async () => {
    const router = new BatchRouter({
      defaultWorkerId: "general",
      planner: {
        planMessages: async () => [{ type: "dispatch", messageId: "m1", workerId: "not-exist" }],
      },
    });
    const result = await router.routeMessages({ messages: [message("m1")], workers, tasks: [] });
    expect(result[0]).toMatchObject({ type: "dispatch", workerId: "general" });
  });
});

describe("BatchRouter worker 事件批次", () => {
  it("可恢复失败按批重试，成功回复结果", async () => {
    const router = new BatchRouter({ retryDelayMs: 10 });
    const actions = await router.routeWorkerEvents({
      events: [
        event(),
        event({
          type: "result",
          taskId: "task-2",
          result: { summary: "done" },
          error: undefined,
        } as any),
      ],
      tasks: [task(), task({ id: "task-2", status: "succeeded", result: { summary: "done" } })],
      workers,
    });
    expect(actions).toContainEqual(
      expect.objectContaining({ type: "retry", taskId: "task-1", delayMs: 10 })
    );
    expect(actions).toContainEqual(expect.objectContaining({ type: "reply", taskId: "task-2" }));
  });

  it("耗尽次数后回复失败，非终态默认等待", async () => {
    const router = new BatchRouter();
    const failed = await router.routeWorkerEvents({
      events: [event()],
      tasks: [task({ attempts: 2, maxAttempts: 2 })],
      workers,
    });
    expect(failed[0]).toMatchObject({
      type: "reply",
      content: expect.stringContaining("temporary"),
    });

    const waiting = await router.routeWorkerEvents({
      events: [event({ type: "progress", message: "working", error: undefined } as any)],
      tasks: [task({ status: "running" })],
      workers,
    });
    expect(waiting).toEqual([{ type: "wait", taskId: "task-1" }]);
  });

  it("LLM 不能用进度提前终局，也不能用 wait/retry 覆盖真实结果", async () => {
    const plannedActions: any[] = [
      { type: "reply", taskId: "task-1", content: "premature" },
      { type: "retry", taskId: "task-2" },
    ];
    const router = new BatchRouter({
      useLlmForWorkerEvents: true,
      planner: { planWorkerEvents: async () => plannedActions },
    });
    const progress = event({ type: "progress", message: "working", error: undefined } as any);
    const waiting = await router.routeWorkerEvents({
      events: [progress],
      tasks: [task({ status: "running" })],
      workers,
    });
    expect(waiting).toEqual([{ type: "wait", taskId: "task-1" }]);

    plannedActions[0] = { type: "wait", taskId: "task-2" };
    const succeeded = task({ id: "task-2", status: "succeeded", result: { summary: "actual" } });
    const completed = await router.routeWorkerEvents({
      events: [
        event({
          type: "result",
          taskId: "task-2",
          result: { summary: "actual" },
          error: undefined,
        } as any),
      ],
      tasks: [succeeded],
      workers,
    });
    expect(completed).toEqual([{ type: "reply", taskId: "task-2" }]);
  });

  it("拒绝非法 retry delayMs 并回退到确定性重试", async () => {
    const router = new BatchRouter({
      retryDelayMs: 25,
      useLlmForWorkerEvents: true,
      planner: {
        planWorkerEvents: async () => [{ type: "retry", taskId: "task-1", delayMs: "bad" } as any],
      },
    });
    const actions = await router.routeWorkerEvents({
      events: [event()],
      tasks: [task()],
      workers,
    });
    expect(actions).toEqual([
      expect.objectContaining({ type: "retry", taskId: "task-1", delayMs: 25 }),
    ]);
  });
});
