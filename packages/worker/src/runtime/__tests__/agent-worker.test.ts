import { describe, expect, it, vi } from "vitest";
import type { WorkerProfile, WorkerTask } from "@aura/protocol";
import { AgentWorker } from "../agent-worker.js";
import { PolicyToolSource } from "../policy.js";
import { ToolRegistry } from "../../capabilities/tools/registry.js";
import type { Provider, StreamChunk } from "../../llm/base.js";

const profile: WorkerProfile = {
  id: "worker-a",
  description: "test",
  capabilities: ["test"],
  outputFormat: "json",
  tools: {},
  memory: { read: false, write: false },
};

function task(id = "task-1", runId = "run-1"): WorkerTask {
  return {
    id,
    runId,
    input: "hello",
    messageIds: ["message-1"],
    origin: { channel: "test", conversationId: "conversation" },
    attempt: 1,
  };
}

function providerWith(chunks: StreamChunk[], onParams?: (params: any) => void): Provider {
  return {
    async *chatStream(params) {
      onParams?.(params);
      for (const chunk of chunks) yield chunk;
    },
  };
}

describe("AgentWorker", () => {
  it("返回结构化结果并发送带 runId 的事件", async () => {
    let modelOptions: any;
    const worker = new AgentWorker({
      id: profile.id,
      profile,
      runtime: {
        provider: providerWith(
          [{ type: "content", delta: '{"summary":"完成","data":{"value":42}}' }],
          (params) => (modelOptions = params)
        ),
        model: "base-model",
      },
    });
    const events: any[] = [];
    worker.subscribe((event) => events.push(event));

    const result = await worker.run(task(), {
      profile: { ...profile, model: "override-model", reasoningEffort: "high" },
    });

    expect(result.summary).toBe("完成");
    expect(result.data).toEqual({ value: 42 });
    expect(modelOptions.model).toBe("override-model");
    expect(modelOptions.options.reasoning_effort).toBe("high");
    expect(modelOptions.options.response_format).toEqual({ type: "json_object" });
    expect(events.some((event) => event.type === "result")).toBe(true);
    expect(events.every((event) => event.runId === "run-1")).toBe(true);
  });

  it("拒绝不符合协议的 JSON，并把 LLM error 视为失败", async () => {
    const invalid = new AgentWorker({
      id: profile.id,
      profile,
      runtime: { provider: providerWith([{ type: "content", delta: "not json" }]), model: "m" },
    });
    await expect(invalid.run(task())).rejects.toThrow("合法 JSON");

    const failed = new AgentWorker({
      id: profile.id,
      profile: { ...profile, outputFormat: "text" },
      runtime: { provider: providerWith([{ type: "error", delta: "provider down" }]), model: "m" },
    });
    await expect(failed.run(task())).rejects.toThrow("provider down");
  });

  it("并发运行使用隔离的 Agent 历史", async () => {
    const histories: string[][] = [];
    const provider: Provider = {
      async *chatStream(params) {
        histories.push(
          params.messages
            .filter((message) => message.role === "user")
            .map((message) => String(message.content))
        );
        await new Promise((resolve) => setTimeout(resolve, 5));
        yield { type: "content", delta: "ok" };
      },
    };
    const worker = new AgentWorker({
      id: profile.id,
      profile: { ...profile, outputFormat: "text" },
      runtime: { provider, model: "m" },
    });
    const first = { ...task("task-1", "run-1"), input: "first" };
    const second = { ...task("task-2", "run-2"), input: "second" };
    await Promise.all([worker.run(first), worker.run(second)]);
    expect(histories).toEqual([["first"], ["second"]]);
  });

  it("把 AbortSignal 传入工具并中断等待中的调用", async () => {
    const registry = new ToolRegistry();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    registry.register(
      { name: "wait", description: "wait", parameters: { type: "object", properties: {} } },
      async (_args, context) => {
        markStarted();
        return new Promise<string>((_resolve, reject) => {
          context?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        });
      }
    );
    const worker = new AgentWorker({
      id: profile.id,
      profile: { ...profile, outputFormat: "text" },
      runtime: {
        provider: providerWith([
          {
            type: "tool_call",
            delta: "",
            toolCall: { index: 0, id: "call", name: "wait", arguments: "{}" },
          },
        ]),
        model: "m",
        tools: registry,
      },
    });
    const controller = new AbortController();
    const running = worker.run(task(), { signal: controller.signal });
    const assertion = expect(running).rejects.toThrow();
    await started;
    controller.abort(new Error("stop"));
    await assertion;
  });
});

describe("PolicyToolSource", () => {
  it("同时过滤 schema 和执行权限，并分离记忆读写", async () => {
    const registry = new ToolRegistry();
    const handler = vi.fn(() => "ok");
    for (const name of ["bash", "memory_search", "memory_save"]) {
      registry.register(
        { name, description: name, parameters: { type: "object", properties: {} } },
        handler
      );
    }
    const source = new PolicyToolSource(registry, { deny: ["bash"] }, { read: true, write: false });
    expect(source.getToolSchemas().map((schema) => schema.function.name)).toEqual([
      "memory_search",
    ]);
    await expect(source.execute("bash", {})).rejects.toThrow("未");
    await expect(source.execute("memory_save", {})).rejects.toThrow("未");
    await source.execute("memory_search", {});
    expect(handler).toHaveBeenCalledOnce();
  });
});
