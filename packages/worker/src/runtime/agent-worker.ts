import type {
  Worker,
  WorkerEvent,
  WorkerEventListener,
  WorkerProfile,
  WorkerResult,
  WorkerRunOptions,
  WorkerTask,
  WorkerStatusEvent,
} from "@aura/protocol";
import { Agent } from "../agent/agent.js";
import type { MemorySource } from "../agent/ports/memory.js";
import type { SkillSource } from "../agent/ports/skill.js";
import type { ToolSource } from "../agent/ports/tool.js";
import type { Provider } from "../llm/base.js";
import type { ChatCompletionOptions } from "../types/types.js";
import { PolicyToolSource } from "./policy.js";
import { parseStructuredResult, STRUCTURED_OUTPUT_INSTRUCTION } from "./structured-result.js";

type WorkerEventInput = WorkerEvent extends infer Event
  ? Event extends WorkerEvent
    ? Omit<Event, "sequence" | "emittedAt">
    : never
  : never;

export const DEFAULT_WORKER_PROFILE: Omit<WorkerProfile, "id" | "description"> = {
  capabilities: [],
  outputFormat: "text",
  tools: {},
  memory: { read: true, write: true },
};

export interface AgentWorkerRuntime {
  provider: Provider;
  model: string;
  systemPrompt?: string | undefined;
  tools?: ToolSource | undefined;
  memory?: MemorySource | undefined;
  skills?: SkillSource | undefined;
  generation?: ChatCompletionOptions | undefined;
}

export interface AgentWorkerOptions {
  id: string;
  runtime: AgentWorkerRuntime;
  profile?: Partial<WorkerProfile> | undefined;
}

/**
 * 将原有单 Agent 适配为 host 可调用的 worker。
 * 每次 run 创建独立 Agent，因此同一实例并发执行也不会串用对话历史。
 */
export class AgentWorker implements Worker {
  readonly id: string;
  private readonly runtime: AgentWorkerRuntime;
  private readonly defaultProfile: WorkerProfile;
  private readonly listeners = new Set<WorkerEventListener>();
  private sequence = 0;

  constructor(options: AgentWorkerOptions) {
    this.id = options.id;
    this.runtime = options.runtime;
    this.defaultProfile = {
      ...DEFAULT_WORKER_PROFILE,
      ...options.profile,
      id: options.id,
      description: options.profile?.description ?? "通用 Agent worker",
      tools: { ...DEFAULT_WORKER_PROFILE.tools, ...options.profile?.tools },
      memory: { ...DEFAULT_WORKER_PROFILE.memory, ...options.profile?.memory },
    };
  }

  subscribe(listener: WorkerEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async run(task: WorkerTask, options: WorkerRunOptions = {}): Promise<WorkerResult> {
    const profile = options.profile ?? this.defaultProfile;
    const signal = options.signal;
    signal?.throwIfAborted();
    this.emitStatus(task.id, task.runId, "running", `第 ${task.attempt} 次执行`);

    let llmError: Error | undefined;
    try {
      const outputInstruction =
        profile.outputFormat === "json" ? `\n${STRUCTURED_OUTPUT_INSTRUCTION}` : "";
      const systemPrompt = `${profile.systemPrompt ?? this.runtime.systemPrompt ?? "你是一个可靠的任务执行 Agent。"}${outputInstruction}`;
      const tools = this.runtime.tools
        ? new PolicyToolSource(this.runtime.tools, profile.tools, profile.memory)
        : undefined;
      const agent = new Agent({
        provider: this.runtime.provider,
        model: profile.model ?? this.runtime.model,
        systemPrompt,
        ...(tools ? { tools } : {}),
        ...(profile.memory.read && this.runtime.memory ? { memory: this.runtime.memory } : {}),
        ...(this.runtime.skills ? { skills: this.runtime.skills } : {}),
        autoMemory: false,
      });
      const generation = {
        ...this.runtime.generation,
        ...profile.generation,
        ...(profile.reasoningEffort ? { reasoning_effort: profile.reasoningEffort } : {}),
        ...(profile.outputFormat === "json"
          ? { response_format: { type: "json_object" as const } }
          : {}),
        ...(signal ? { signal } : {}),
      } satisfies ChatCompletionOptions;

      this.emit({
        type: "progress",
        taskId: task.id,
        runId: task.runId,
        workerId: this.id,
        message: "worker 已接收任务",
        progress: 0,
      });
      const result = await agent.chat(task.input, generation, {
        onContentChunk: (delta) =>
          this.emit({
            type: "output",
            taskId: task.id,
            runId: task.runId,
            workerId: this.id,
            stream: "content",
            delta,
          }),
        onReasoningChunk: (delta) =>
          this.emit({
            type: "output",
            taskId: task.id,
            runId: task.runId,
            workerId: this.id,
            stream: "reasoning",
            delta,
          }),
        onToolCallStart: (toolCall) =>
          this.emit({
            type: "progress",
            taskId: task.id,
            runId: task.runId,
            workerId: this.id,
            message: `调用工具：${toolCall.function.name}`,
          }),
        onLLMError: (error) => {
          llmError = error;
        },
      });
      signal?.throwIfAborted();
      if (llmError) throw llmError;

      const structured: WorkerResult =
        profile.outputFormat === "json"
          ? parseStructuredResult(result.content)
          : { summary: result.content, raw: result.content };

      this.emit({
        type: "result",
        taskId: task.id,
        runId: task.runId,
        workerId: this.id,
        result: structured,
      });
      this.emitStatus(task.id, task.runId, "succeeded");
      return structured;
    } catch (error) {
      const normalized = error instanceof Error ? error : new Error(String(error));
      const cancelled = signal?.aborted === true || normalized.name === "AbortError";
      this.emit({
        type: "error",
        taskId: task.id,
        runId: task.runId,
        workerId: this.id,
        error: {
          message: normalized.message,
          retryable: !cancelled,
          ...(cancelled ? { code: "ABORTED" } : {}),
        },
      });
      this.emitStatus(task.id, task.runId, cancelled ? "cancelled" : "failed", normalized.message);
      throw normalized;
    }
  }

  private emitStatus(
    taskId: string,
    runId: string,
    status: WorkerStatusEvent["status"],
    message?: string
  ): void {
    this.emit({
      type: "status",
      taskId,
      runId,
      workerId: this.id,
      status,
      ...(message ? { message } : {}),
    });
  }

  private emit(event: WorkerEventInput): void {
    const enriched = {
      ...event,
      sequence: ++this.sequence,
      emittedAt: new Date().toISOString(),
    } as WorkerEvent;
    for (const listener of this.listeners) {
      try {
        listener(enriched);
      } catch {
        // 订阅者故障不能中断 worker 执行；host 会在自身事件队列中处理异常。
      }
    }
  }
}
