import { describe, expect, it, vi } from "vitest";
import type {
  InboundMessage,
  TaskRecord,
  Worker,
  WorkerEvent,
  WorkerEventListener,
  WorkerProfile,
  WorkerResult,
  WorkerRunOptions,
  WorkerTask,
} from "@aura/protocol";
import { BatchRouter } from "@aura/router";
import { Host } from "../host.js";
import { FunctionChannel } from "../channel.js";
import { MemoryHostStore } from "../store.js";

const profile: WorkerProfile = {
  id: "worker",
  description: "test worker",
  capabilities: ["test"],
  outputFormat: "text",
  tools: {},
  memory: { read: false, write: false },
};

class FakeWorker implements Worker {
  readonly id = "worker";
  readonly runs: WorkerTask[] = [];
  private readonly listeners = new Set<WorkerEventListener>();

  constructor(
    private readonly behavior: (
      task: WorkerTask,
      options?: WorkerRunOptions
    ) => Promise<WorkerResult> = async () => ({ summary: "done" })
  ) {}

  subscribe(listener: WorkerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async run(task: WorkerTask, options?: WorkerRunOptions): Promise<WorkerResult> {
    this.runs.push(task);
    return this.behavior(task, options);
  }

  emit(event: WorkerEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function message(id: string, content = id): InboundMessage {
  return {
    id,
    externalId: id,
    channel: "memory",
    conversationId: "conversation",
    senderId: "user",
    content,
    kind: "message",
    receivedAt: new Date().toISOString(),
  };
}

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  const now = new Date().toISOString();
  return {
    id: "persisted-task",
    runId: "persisted-run",
    input: "persisted input",
    messageIds: ["persisted-message"],
    origin: { channel: "memory", conversationId: "conversation" },
    attempt: 1,
    attempts: 1,
    workerId: "worker",
    status: "succeeded",
    priority: 0,
    maxAttempts: 2,
    profile,
    createdAt: now,
    updatedAt: now,
    version: 1,
    result: { summary: "persisted result" },
    ...overrides,
  };
}

function createHost(
  worker: FakeWorker,
  channel: FunctionChannel,
  store = new MemoryHostStore()
): Host {
  const host = new Host({
    store,
    router: new BatchRouter({ defaultWorkerId: "worker", retryDelayMs: 0 }),
    batchIntervalMs: 5,
    maxConcurrentTasks: 2,
  });
  host.registerWorker(worker, profile);
  host.registerChannel(channel);
  return host;
}

describe("Host", () => {
  it("任务执行期间仍接受新消息，并并发运行隔离任务", async () => {
    const resolvers = new Map<string, (result: WorkerResult) => void>();
    const worker = new FakeWorker(
      (task) =>
        new Promise((resolve) => {
          resolvers.set(task.id, resolve);
        })
    );
    const channel = new FunctionChannel("memory");
    const host = createHost(worker, channel);
    await host.start();
    await host.ingest(message("m1"));
    await host.ingest(message("m2"));
    await vi.waitFor(() => expect(worker.runs).toHaveLength(2));
    expect(host.listTasks().every((task) => task.status === "running")).toBe(true);

    for (const [index, task] of worker.runs.entries()) {
      resolvers.get(task.id)?.({ summary: `done-${index}` });
    }
    await vi.waitFor(() => expect(channel.messages).toHaveLength(2));
    expect(host.listTasks().map((task) => task.status)).toEqual(["succeeded", "succeeded"]);
    await host.stop();
  });

  it("失败任务经事件批次决策后重试，且每次使用新 runId", async () => {
    let invocation = 0;
    const worker = new FakeWorker(async () => {
      invocation += 1;
      if (invocation === 1) throw new Error("temporary");
      return { summary: "recovered" };
    });
    const channel = new FunctionChannel("memory");
    const host = createHost(worker, channel);
    await host.start();
    await host.ingest(message("m1"));
    await vi.waitFor(() => expect(host.listTasks()[0]?.status).toBe("succeeded"));
    await vi.waitFor(() => expect(channel.messages).toHaveLength(1));

    expect(worker.runs).toHaveLength(2);
    expect(worker.runs[0]?.runId).not.toBe(worker.runs[1]?.runId);
    expect(host.listTasks()[0]?.attempts).toBe(2);
    expect(channel.messages[0]?.content).toBe("recovered");
    await host.stop();
  });

  it("取消优先于迟到结果，旧 runId 事件不会触发通知", async () => {
    const worker = new FakeWorker(
      (_task, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        })
    );
    const channel = new FunctionChannel("memory");
    const host = createHost(worker, channel);
    await host.start();
    await host.ingest(message("m1"));
    await vi.waitFor(() => expect(worker.runs).toHaveLength(1));
    const task = host.listTasks()[0]!;
    await host.cancelTask(task.id);
    await vi.waitFor(() => expect(host.getTask(task.id)?.status).toBe("cancelled"));
    worker.emit({
      type: "progress",
      taskId: task.id,
      runId: task.runId,
      workerId: worker.id,
      sequence: 99,
      emittedAt: new Date().toISOString(),
      message: "late",
    });
    await host.flush();
    expect(channel.messages).toHaveLength(1);
    expect(channel.messages[0]?.content).toContain("取消");
    await host.stop();
  });

  it("按渠道外部 ID 去重，并恢复持久化的中断任务", async () => {
    const store = new MemoryHostStore();
    const firstWorker = new FakeWorker();
    const firstHost = createHost(firstWorker, new FunctionChannel("memory"), store);
    await firstHost.start();
    expect(await firstHost.ingest(message("duplicate"))).toBe(true);
    expect(await firstHost.ingest(message("duplicate"))).toBe(false);
    await vi.waitFor(() => expect(firstHost.listTasks()[0]?.status).toBe("succeeded"));
    await firstHost.stop();

    const interrupted = firstHost.listTasks()[0]!;
    const { result: _result, ...withoutResult } = interrupted;
    const state = await store.read();
    state.tasks = [
      {
        ...withoutResult,
        id: "interrupted",
        runId: "old-run",
        status: "running",
        attempts: 1,
        attempt: 1,
        maxAttempts: 2,
      },
    ];
    await store.write(state);
    const secondWorker = new FakeWorker(async () => ({ summary: "restored" }));
    const secondChannel = new FunctionChannel("memory");
    const secondHost = createHost(secondWorker, secondChannel, store);
    await secondHost.start();
    await vi.waitFor(() => expect(secondHost.getTask("interrupted")?.status).toBe("succeeded"));
    expect(secondWorker.runs[0]?.runId).not.toBe("old-run");
    await secondHost.stop();
  });

  it("从已持久化终态重建结果通知和失败重试", async () => {
    const succeededStore = new MemoryHostStore({ tasks: [taskRecord()] });
    const succeededChannel = new FunctionChannel("memory");
    const succeededWorker = new FakeWorker();
    const succeededHost = createHost(succeededWorker, succeededChannel, succeededStore);
    await succeededHost.start();
    await vi.waitFor(() => expect(succeededChannel.messages).toHaveLength(1));
    expect(succeededChannel.messages[0]?.content).toBe("persisted result");
    expect(succeededWorker.runs).toHaveLength(0);
    await succeededHost.stop();

    const failed = taskRecord({
      id: "failed-task",
      status: "failed",
      error: "temporary",
    });
    delete failed.result;
    const failedStore = new MemoryHostStore({ tasks: [failed] });
    const failedChannel = new FunctionChannel("memory");
    const failedWorker = new FakeWorker(async () => ({ summary: "retried after restart" }));
    const failedHost = createHost(failedWorker, failedChannel, failedStore);
    await failedHost.start();
    await vi.waitFor(() => expect(failedHost.getTask("failed-task")?.status).toBe("succeeded"));
    expect(failedWorker.runs).toHaveLength(1);
    await failedHost.stop();
  });

  it("失败等待 router 决策时仍可取消，取消后不会重试", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const router = new BatchRouter({
      defaultWorkerId: "worker",
      useLlmForWorkerEvents: true,
      planner: {
        planWorkerEvents: async () => {
          await gate;
          return [];
        },
      },
    });
    const worker = new FakeWorker(async () => {
      throw new Error("temporary");
    });
    const channel = new FunctionChannel("memory");
    const host = new Host({ router, batchIntervalMs: 1 });
    host.registerWorker(worker, profile);
    host.registerChannel(channel);
    await host.start();
    await host.ingest(message("m1"));
    await vi.waitFor(() => expect(host.listTasks()[0]?.status).toBe("failed"));
    expect(await host.cancelTask("unused")).toBe(false);
    const task = host.listTasks()[0]!;
    expect(await host.cancelTask(task.id)).toBe(true);
    release();
    await vi.waitFor(() => expect(host.getTask(task.id)?.status).toBe("cancelled"));
    await host.flush();
    expect(worker.runs).toHaveLength(1);
    await host.stop();
  });

  it("stop 排空事件时不会启动新 retry", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const router = new BatchRouter({
      defaultWorkerId: "worker",
      useLlmForWorkerEvents: true,
      planner: {
        planWorkerEvents: async () => {
          await gate;
          return [];
        },
      },
    });
    const worker = new FakeWorker(async () => {
      throw new Error("temporary");
    });
    const host = new Host({ router, batchIntervalMs: 1 });
    host.registerWorker(worker, profile);
    host.registerChannel(new FunctionChannel("memory"));
    await host.start();
    await host.ingest(message("m1"));
    await vi.waitFor(() => expect(host.listTasks()[0]?.status).toBe("failed"));
    const stopping = host.stop();
    release();
    await stopping;
    expect(worker.runs).toHaveLength(1);
    expect(host.listTasks()[0]?.status).toBe("cancelled");
  });

  it("故障渠道不会阻塞其他渠道的 outbox", async () => {
    const bad = {
      id: "bad",
      start: async () => undefined,
      send: vi.fn(async () => {
        throw new Error("permanent channel error");
      }),
    };
    const good = new FunctionChannel("good");
    const worker = new FakeWorker(async (task) => ({ summary: `reply for ${task.input}` }));
    const host = new Host({
      router: new BatchRouter({ defaultWorkerId: "worker" }),
      batchIntervalMs: 1,
      outboxRetryMs: 10_000,
    });
    host.registerWorker(worker, profile);
    host.registerChannel(bad);
    host.registerChannel(good);
    await host.start();
    await host.ingest({ ...message("bad-message"), channel: "bad" });
    await vi.waitFor(() => expect(bad.send).toHaveBeenCalled());
    await host.ingest({ ...message("good-message"), channel: "good" });
    await vi.waitFor(() => expect(good.messages).toHaveLength(1));
    expect(good.messages[0]?.content).toBe("reply for good-message");
    await host.stop();
  });

  it("worker 忽略 abort 时 stop 有超时兜底", async () => {
    const worker = new FakeWorker(async () => new Promise<WorkerResult>(() => undefined));
    const host = new Host({
      router: new BatchRouter({ defaultWorkerId: "worker" }),
      batchIntervalMs: 1,
      stopTimeoutMs: 10,
    });
    host.registerWorker(worker, profile);
    host.registerChannel(new FunctionChannel("memory"));
    await host.start();
    await host.ingest(message("m1"));
    await vi.waitFor(() => expect(worker.runs).toHaveLength(1));
    await host.stop();
    expect(worker.runs).toHaveLength(1);
    expect(host.listTasks()[0]?.status).toBe("cancel_requested");
  });

  it("outbox 投递期间的新消息会进入后续 drain", async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => (releaseFirst = resolve));
    let markFirstStarted!: () => void;
    const firstStarted = new Promise<void>((resolve) => (markFirstStarted = resolve));
    const sent: string[] = [];
    const channel = {
      id: "memory",
      start: async () => undefined,
      send: async (outbound: { content: string }) => {
        sent.push(outbound.content);
        if (sent.length === 1) {
          markFirstStarted();
          await firstGate;
        }
      },
    };
    const worker = new FakeWorker(async (task) => ({ summary: `reply:${task.input}` }));
    const host = new Host({
      router: new BatchRouter({ defaultWorkerId: "worker" }),
      batchIntervalMs: 1,
    });
    host.registerWorker(worker, profile);
    host.registerChannel(channel);
    await host.start();
    await host.ingest(message("first"));
    await firstStarted;
    await host.ingest(message("second"));
    await vi.waitFor(() => expect(worker.runs).toHaveLength(2));
    const flushing = host.flush();
    releaseFirst();
    await flushing;
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent).toEqual(["reply:first", "reply:second"]);
    await host.stop();
  });

  it("同一 Host 正常 stop 后可以重新 start 并处理新消息", async () => {
    const worker = new FakeWorker(async (task) => ({ summary: `reply:${task.input}` }));
    const channel = new FunctionChannel("memory");
    const host = createHost(worker, channel);
    await host.start();
    await host.ingest(message("before-stop"));
    await vi.waitFor(() => expect(channel.messages).toHaveLength(1));
    await host.stop();

    await host.start();
    await host.ingest(message("after-restart"));
    await vi.waitFor(() => expect(channel.messages).toHaveLength(2));
    expect(channel.messages[1]?.content).toBe("reply:after-restart");
    expect(worker.runs).toHaveLength(2);
    await host.stop();
  });

  it("flush 会排空可立即执行的重试链并投递最终失败通知", async () => {
    const worker = new FakeWorker(async () => {
      throw new Error("always fails");
    });
    const channel = new FunctionChannel("memory");
    const host = new Host({
      router: new BatchRouter({
        defaultWorkerId: "worker",
        defaultMaxAttempts: 3,
        retryDelayMs: 0,
      }),
      batchIntervalMs: 60_000,
    });
    host.registerWorker(worker, profile);
    host.registerChannel(channel);
    await host.start();
    await host.ingest(message("m1"));

    await host.flush();

    expect(worker.runs).toHaveLength(3);
    expect(host.listTasks()[0]).toMatchObject({ status: "failed", attempts: 3 });
    expect(channel.messages).toHaveLength(1);
    expect(channel.messages[0]?.content).toContain("always fails");
    await host.stop();
  });

  it("发送成功后持久化失败会保留 outbox 消息并再次投递", async () => {
    const store = new MemoryHostStore();
    const write = store.write.bind(store);
    let failNextWrite = false;
    store.write = async (state) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error("outbox commit failed");
      }
      await write(state);
    };
    let sends = 0;
    const channel = {
      id: "memory",
      start: async () => undefined,
      send: vi.fn(async () => {
        sends += 1;
        if (sends === 1) failNextWrite = true;
      }),
    };
    const worker = new FakeWorker(async () => ({ summary: "done" }));
    const host = new Host({
      store,
      router: new BatchRouter({ defaultWorkerId: "worker" }),
      batchIntervalMs: 1,
      outboxRetryMs: 60_000,
    });
    host.registerWorker(worker, profile);
    host.registerChannel(channel);
    await host.start();
    await host.ingest(message("m1"));

    await host.flush();

    expect(sends).toBe(2);
    expect((await store.read()).outbox).toHaveLength(0);
    await host.stop();
  });
});
