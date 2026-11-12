import type { InboundMessage, TaskRecord, WorkerEvent, WorkerProfile } from "@aura/protocol";
import type {
  MessageBatch,
  RouteDecision,
  RouteRule,
  Router,
  RouterConfig,
  WorkerAction,
  WorkerEventBatch,
} from "./types.js";

export class BatchRouter implements Router {
  private readonly rules: RouteRule[];
  private readonly config: RouterConfig;

  constructor(config: RouterConfig = {}) {
    this.config = config;
    this.rules = [...(config.rules ?? [])].sort(
      (left, right) => (right.priority ?? 0) - (left.priority ?? 0)
    );
    // 配置错误应在启动时暴露，而不是收到消息后才失败。
    for (const rule of this.rules) {
      if (rule.match.pattern) new RegExp(rule.match.pattern, rule.match.flags);
    }
  }

  async routeMessages(batch: MessageBatch): Promise<RouteDecision[]> {
    const decisions = new Map<string, RouteDecision>();
    const unmatched: InboundMessage[] = [];

    for (const message of batch.messages) {
      const rule = this.rules.find((candidate) => this.matches(candidate, message));
      if (!rule) {
        unmatched.push(message);
        continue;
      }
      const decision = { ...rule.decision, messageId: message.id } as RouteDecision;
      if (decision.type === "dispatch") {
        const worker = this.resolveWorker(decision, batch.workers);
        decisions.set(
          message.id,
          worker
            ? {
                ...decision,
                workerId: worker.id,
                maxAttempts: this.normalizeMaxAttempts(decision.maxAttempts),
              }
            : {
                type: "reply",
                messageId: message.id,
                content: `规则 ${rule.name} 没有匹配的可用 worker。`,
              }
        );
      } else {
        decisions.set(message.id, decision);
      }
    }

    if (unmatched.length > 0 && this.config.planner?.planMessages) {
      try {
        const planned = await this.config.planner.planMessages({
          ...batch,
          messages: unmatched,
        });
        for (const decision of this.validateMessageDecisions(planned, unmatched, batch)) {
          decisions.set(decision.messageId, decision);
        }
      } catch {
        // LLM 不是状态真相来源；失败时走确定性的默认 worker/错误回复。
      }
    }

    for (const message of unmatched) {
      if (!decisions.has(message.id)) {
        decisions.set(message.id, this.fallbackMessageDecision(message, batch.workers));
      }
    }

    return batch.messages.map(
      (message) => decisions.get(message.id) ?? this.fallbackMessageDecision(message, batch.workers)
    );
  }

  async routeWorkerEvents(batch: WorkerEventBatch): Promise<WorkerAction[]> {
    const tasks = new Map(batch.tasks.map((task) => [task.id, task]));
    const relevant = batch.events.filter((event) => tasks.has(event.taskId));
    const fallback = this.deterministicWorkerActions(relevant, tasks);

    if (!this.config.useLlmForWorkerEvents || !this.config.planner?.planWorkerEvents) {
      return fallback;
    }

    let planned: WorkerAction[];
    try {
      planned = await this.config.planner.planWorkerEvents({
        ...batch,
        events: relevant,
      });
    } catch {
      return fallback;
    }

    const relevantByTask = new Map<string, WorkerEvent[]>();
    for (const event of relevant) {
      const events = relevantByTask.get(event.taskId) ?? [];
      events.push(event);
      relevantByTask.set(event.taskId, events);
    }
    const actions = new Map<string, WorkerAction>();
    for (const action of planned) {
      const task = tasks.get(action.taskId);
      const taskEvents = task ? relevantByTask.get(task.id) : undefined;
      if (!task || !taskEvents || !this.isWorkerAction(action)) continue;
      const hasTerminal = taskEvents.some(
        (event) =>
          event.type === "result" ||
          event.type === "error" ||
          (event.type === "status" && ["failed", "cancelled", "succeeded"].includes(event.status))
      );
      if (hasTerminal) {
        if (!["reply", "retry", "fail"].includes(action.type)) continue;
        if (
          action.type === "reply" &&
          !["succeeded", "failed", "cancelled"].includes(task.status)
        ) {
          continue;
        }
        if (
          action.type === "retry" &&
          (task.status !== "failed" || task.attempts >= task.maxAttempts)
        ) {
          continue;
        }
        if (action.type === "fail" && task.status !== "failed") continue;
      } else if (!["wait", "notify", "cancel"].includes(action.type)) {
        continue;
      }
      // 每个任务每批最多执行一个后续动作，终态动作优先于进度通知。
      const previous = actions.get(action.taskId);
      if (!previous || this.actionPriority(action.type) >= this.actionPriority(previous.type)) {
        actions.set(action.taskId, action);
      }
    }
    for (const action of fallback) {
      if (!actions.has(action.taskId)) actions.set(action.taskId, action);
    }
    return [...actions.values()];
  }

  private deterministicWorkerActions(
    events: WorkerEvent[],
    tasks: Map<string, TaskRecord>
  ): WorkerAction[] {
    const byTask = new Map<string, WorkerEvent[]>();
    for (const event of events) {
      const list = byTask.get(event.taskId) ?? [];
      list.push(event);
      byTask.set(event.taskId, list);
    }

    const actions: WorkerAction[] = [];
    for (const [taskId, taskEvents] of byTask) {
      const task = tasks.get(taskId)!;
      taskEvents.sort((left, right) => left.sequence - right.sequence);
      const terminal = [...taskEvents]
        .reverse()
        .find(
          (event) =>
            event.type === "result" ||
            event.type === "error" ||
            (event.type === "status" && ["failed", "cancelled", "succeeded"].includes(event.status))
        );

      if (!terminal) {
        if (this.config.notifyProgress) {
          const progress = [...taskEvents]
            .reverse()
            .find((event) => event.type === "progress" || event.type === "status");
          if (progress) {
            actions.push({
              type: "notify",
              taskId,
              content:
                progress.type === "progress"
                  ? progress.message
                  : progress.type === "status"
                    ? (progress.message ?? `任务状态：${progress.status}`)
                    : "任务执行中",
            });
          } else {
            actions.push({ type: "wait", taskId });
          }
        } else {
          actions.push({ type: "wait", taskId });
        }
        continue;
      }

      if (
        terminal.type === "result" ||
        (terminal.type === "status" && terminal.status === "succeeded")
      ) {
        actions.push({ type: "reply", taskId });
      } else if (terminal.type === "status" && terminal.status === "cancelled") {
        actions.push({ type: "reply", taskId, content: terminal.message ?? "任务已取消。" });
      } else {
        const message =
          terminal.type === "error"
            ? terminal.error.message
            : terminal.type === "status"
              ? (terminal.message ?? "worker 执行失败")
              : (task.error ?? "worker 执行失败");
        const retryable = terminal.type !== "error" || terminal.error.retryable !== false;
        if (retryable && task.attempts < task.maxAttempts) {
          actions.push({
            type: "retry",
            taskId,
            delayMs: this.config.retryDelayMs ?? 1000,
            reason: message,
          });
        } else {
          actions.push({ type: "reply", taskId, content: `任务失败：${message}` });
        }
      }
    }
    return actions;
  }

  private validateMessageDecisions(
    decisions: RouteDecision[],
    messages: InboundMessage[],
    batch: MessageBatch
  ): RouteDecision[] {
    const allowedIds = new Set(messages.map((message) => message.id));
    const valid: RouteDecision[] = [];
    const seen = new Set<string>();
    for (const decision of decisions) {
      if (
        !decision ||
        !allowedIds.has(decision.messageId) ||
        seen.has(decision.messageId) ||
        !["dispatch", "reply", "ignore", "cancel"].includes(decision.type)
      ) {
        continue;
      }
      if (decision.type === "dispatch") {
        const worker = this.resolveWorker(decision, batch.workers);
        if (!worker) continue;
        valid.push({
          ...decision,
          workerId: worker.id,
          maxAttempts: this.normalizeMaxAttempts(decision.maxAttempts),
        });
      } else if (decision.type === "reply" && typeof decision.content === "string") {
        valid.push(decision);
      } else if (decision.type === "ignore" || decision.type === "cancel") {
        valid.push(decision);
      }
      seen.add(decision.messageId);
    }
    return valid;
  }

  private fallbackMessageDecision(
    message: InboundMessage,
    workers: WorkerProfile[]
  ): RouteDecision {
    const configured = this.config.defaultWorkerId
      ? workers.find((worker) => worker.id === this.config.defaultWorkerId)
      : undefined;
    const worker = configured ?? (workers.length === 1 ? workers[0] : undefined);
    if (!worker) {
      return {
        type: "reply",
        messageId: message.id,
        content: "暂时无法分派该任务：没有可用的默认 worker，请检查路由配置。",
      };
    }
    return {
      type: "dispatch",
      messageId: message.id,
      workerId: worker.id,
      maxAttempts: this.normalizeMaxAttempts(),
    };
  }

  private resolveWorker(
    decision: Extract<RouteDecision, { type: "dispatch" }>,
    workers: WorkerProfile[]
  ): WorkerProfile | undefined {
    const required = decision.requiredCapabilities ?? [];
    return workers.find(
      (worker) =>
        (!decision.workerId || worker.id === decision.workerId) &&
        required.every((capability) => worker.capabilities.includes(capability))
    );
  }

  private matches(rule: RouteRule, message: InboundMessage): boolean {
    if (rule.match.channel && rule.match.channel !== message.channel) return false;
    if (rule.match.kind && rule.match.kind !== message.kind) return false;
    if (rule.match.senderId && rule.match.senderId !== message.senderId) return false;
    if (
      rule.match.pattern &&
      !new RegExp(rule.match.pattern, rule.match.flags).test(message.content)
    ) {
      return false;
    }
    return true;
  }

  private normalizeMaxAttempts(value?: number): number {
    const configured = this.config.defaultMaxAttempts ?? 2;
    const candidate = typeof value === "number" && Number.isFinite(value) ? value : configured;
    const safe = Number.isFinite(candidate) ? candidate : 2;
    return Math.max(1, Math.min(10, Math.floor(safe)));
  }

  private isWorkerAction(action: WorkerAction): boolean {
    if (!action || typeof action !== "object" || typeof action.taskId !== "string") return false;
    if (action.type === "retry") {
      return (
        action.delayMs === undefined ||
        (typeof action.delayMs === "number" &&
          Number.isFinite(action.delayMs) &&
          action.delayMs >= 0)
      );
    }
    if (action.type === "reply") {
      return action.content === undefined || typeof action.content === "string";
    }
    if (action.type === "notify") return typeof action.content === "string";
    if (action.type === "fail") return typeof action.reason === "string";
    return ["wait", "cancel"].includes(action.type);
  }

  private actionPriority(type: WorkerAction["type"]): number {
    return { wait: 0, notify: 1, cancel: 2, retry: 3, fail: 3, reply: 4 }[type];
  }
}
