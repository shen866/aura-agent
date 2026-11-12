import type {
  MessageBatch,
  RouteDecision,
  RouterPlanner,
  WorkerAction,
  WorkerEventBatch,
} from "./types.js";

export interface RouterModelRequest {
  systemPrompt: string;
  userPrompt: string;
  signal: AbortSignal;
}

export interface RouterLanguageModel {
  complete(request: RouterModelRequest): Promise<string>;
}

export interface LlmRouterPlannerOptions {
  model: RouterLanguageModel;
  timeoutMs?: number | undefined;
}

/** LLM 只生成路由命令，不接触任务状态或 worker。 */
export class LlmRouterPlanner implements RouterPlanner {
  private readonly model: RouterLanguageModel;
  private readonly timeoutMs: number;

  constructor(options: LlmRouterPlannerOptions) {
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async planMessages(batch: MessageBatch): Promise<RouteDecision[]> {
    const response = await this.complete(
      `你是多 Agent 系统的任务 router。根据消息和 worker 能力选择动作。` +
        `只返回 JSON：{"decisions":[...]}。每个 decision 必须包含 messageId，type 为 dispatch/reply/ignore/cancel。` +
        `dispatch 可包含 workerId、requiredCapabilities、input、priority(数字)、maxAttempts(1-10)；` +
        `只能使用给定 worker ID。简单问答也可 dispatch 给通用 worker。reply 必须包含 content。` +
        `cancel 必须包含已有 taskId。不要返回 Markdown 或额外解释。`,
      JSON.stringify({
        messages: batch.messages,
        workers: batch.workers.map(({ id, description, capabilities, model, outputFormat }) => ({
          id,
          description,
          capabilities,
          model,
          outputFormat,
        })),
        activeTasks: batch.tasks.filter((task) =>
          ["queued", "retry_wait", "running", "cancel_requested"].includes(task.status)
        ),
      })
    );
    const value = parseJsonObject(response);
    const decisions = value.decisions;
    if (!Array.isArray(decisions)) throw new Error("router LLM 未返回 decisions 数组");
    return decisions as RouteDecision[];
  }

  async planWorkerEvents(batch: WorkerEventBatch): Promise<WorkerAction[]> {
    const response = await this.complete(
      `你是多 Agent 系统的执行结果 router。按批次分析 worker 事件并决定后续动作。` +
        `只返回 JSON：{"actions":[...]}。每个 action 包含 taskId 和 type：` +
        `wait/retry/reply/fail/cancel/notify。retry 仅用于仍有重试次数的可恢复失败；` +
        `reply 用于给用户最终结果，可包含 content，缺省时 host 使用 result.summary；` +
        `notify 用于非终态进度，必须包含 content；fail 必须包含 reason。` +
        `每个 taskId 最多返回一个 action，不要返回 Markdown 或额外解释。`,
      JSON.stringify({
        events: batch.events.filter((event) => event.type !== "output"),
        tasks: batch.tasks,
      })
    );
    const value = parseJsonObject(response);
    if (!Array.isArray(value.actions)) throw new Error("router LLM 未返回 actions 数组");
    return value.actions as WorkerAction[];
  }

  private async complete(systemPrompt: string, userPrompt: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("router LLM 决策超时")),
      this.timeoutMs
    );
    try {
      return await this.model.complete({
        systemPrompt,
        userPrompt,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}

function parseJsonObject(content: string): Record<string, unknown> {
  const normalized = content
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const parsed: unknown = JSON.parse(normalized);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("router LLM 必须返回 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}
