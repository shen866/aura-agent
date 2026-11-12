import { createId, type InboundMessage, type TaskRecord } from "@aura/protocol";
import type { HostEvent } from "@aura/host";
import { createProvider } from "@aura/worker";
import type { ChatStore, Conversation, ConversationSummary } from "./chat-store.js";
import {
  configIssues,
  defaultConfig,
  FileConfigStore,
  getSecretStatus,
  isModelConfigured,
  mergeConfigSecrets,
  normalizeConfig,
  publicConfig,
  type AppConfig,
  type SecretStatus,
} from "./config.js";
import { ApiError, ConfigValidationError } from "./errors.js";
import type { EventHub } from "./event-hub.js";
import { MonitorStore, type MonitorEntry } from "./monitor-store.js";
import { buildRuntime, type RuntimeBuild, type WebhookRoute } from "./runtime.js";
import {
  ACTIVE_TASK_STATUSES,
  summarizeTask,
  taskStats,
  type AppStatus,
  type TaskStats,
  type TaskSummary,
  type WorkerInfo,
} from "./views.js";

export interface AppManagerOptions {
  configPath: string;
  hub: EventHub;
  chatStore: ChatStore;
  log?: ((message: string) => void) | undefined;
}

export interface ManagedConversationSummary extends ConversationSummary {
  activeTasks: number;
}

export interface ConversationView {
  conversation: Conversation;
  activeTasks: TaskSummary[];
}

export interface TaskListOptions {
  status?: string | undefined;
  workerId?: string | undefined;
  search?: string | undefined;
  limit?: number | undefined;
}

export interface TaskDetail {
  task: TaskRecord;
  events: MonitorEntry[];
}

export interface ApplyResult {
  config: AppConfig;
  secretStatus: SecretStatus;
  status: AppStatus;
  warnings: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim() : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 控制台后端：唯一拥有 Host 生命周期和配置权威。 */
export class AppManager {
  readonly configStore: FileConfigStore;
  private readonly hub: EventHub;
  private readonly chatStore: ChatStore;
  private readonly monitor = new MonitorStore();
  private readonly logLine: (message: string) => void;
  private config: AppConfig = defaultConfig();
  private runtime: RuntimeBuild | undefined;
  private host: RuntimeBuild["host"] | undefined;
  private unsubscribeHost: (() => void) | undefined;
  private taskConversations = new Map<string, string>();
  private state: AppStatus["state"] = "starting";
  private startedAt: string | undefined;
  private lastError: string | undefined;
  private configWarnings: string[] = [];
  private applying = false;
  private busy = false;
  private loaded = false;

  constructor(options: AppManagerOptions) {
    this.configStore = new FileConfigStore(options.configPath);
    this.hub = options.hub;
    this.chatStore = options.chatStore;
    this.logLine = options.log ?? ((message) => console.error(`[Aura] ${message}`));
  }

  get configFilePath(): string {
    return this.configStore.path;
  }

  get isRunning(): boolean {
    return this.state === "running" || this.state === "applying";
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await this.configStore.read();
      if (raw !== undefined) {
        const result = normalizeConfig(raw, { strict: false });
        this.config = result.config;
        this.configWarnings = [...result.errors, ...result.warnings];
      }
    } catch (error) {
      this.configWarnings = [`配置文件读取失败，已使用默认配置：${errorMessage(error)}`];
      this.logLine(this.configWarnings[0]!);
    }
    await this.chatStore.load();
    if (this.chatStore.warning) {
      this.configWarnings.push(this.chatStore.warning);
      this.logLine(this.chatStore.warning);
    }
    this.publishStatus();
  }

  /** 初始启动失败不抛出，保证设置页面仍可访问。 */
  async start(): Promise<void> {
    try {
      await this.activate(this.config, { persist: false, warnings: this.configWarnings });
    } catch (error) {
      this.lastError = errorMessage(error);
      this.state = "error";
      this.logLine(`启动失败：${this.lastError}`);
      this.publishStatus();
    }
  }

  publicConfig(): AppConfig {
    return publicConfig(this.config);
  }

  secretStatus(): SecretStatus {
    return getSecretStatus(this.config);
  }

  status(): AppStatus {
    const tasks = this.host?.listTasks() ?? [];
    if (this.host) {
      this.monitor.prune(new Set(tasks.map((task) => task.id)));
    }
    const model = this.config.model;
    const workers: WorkerInfo[] =
      this.runtime?.workers.map((worker) => ({
        id: worker.id,
        description: worker.description,
        capabilities: worker.capabilities,
        model: worker.model ?? model.model,
        outputFormat: worker.outputFormat,
      })) ??
      this.config.workers.map((worker) => ({
        id: worker.id,
        description: worker.description,
        capabilities: worker.capabilities,
        model: worker.model || model.model,
        outputFormat: worker.outputFormat,
      }));
    const webhooks: WebhookRoute[] = this.runtime?.webhooks.map((webhook) => ({
      channel: webhook.channel,
      path: webhook.path,
      active: webhook.active,
      ...(webhook.adapter !== undefined ? { adapter: webhook.adapter } : {}),
    })) ?? [
      { channel: "github", path: "/webhooks/github", active: false },
      { channel: "gitlab", path: "/webhooks/gitlab", active: false },
    ];
    return {
      state: this.applying ? "applying" : this.state,
      ...(this.startedAt !== undefined ? { startedAt: this.startedAt } : {}),
      configPath: this.configStore.path,
      configWarnings: this.configWarnings,
      issues: configIssues(this.config),
      model: {
        format: model.format,
        model: model.model,
        routerModel: model.routerModel || model.model,
        configured: isModelConfigured(this.config) && model.format === "openai",
      },
      workers,
      channels: this.runtime?.channels ?? [],
      webhooks: webhooks.map(({ channel, path, active }) => ({ channel, path, active })),
      stats: taskStats(tasks),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
    };
  }

  listTasks(options: TaskListOptions = {}): TaskSummary[] {
    const tasks = this.host?.listTasks() ?? [];
    const status = options.status?.trim();
    const workerId = options.workerId?.trim();
    const search = options.search?.trim().toLowerCase();
    return [...tasks]
      .filter((task) => !status || task.status === status)
      .filter((task) => !workerId || task.workerId === workerId)
      .filter(
        (task) =>
          !search ||
          task.input.toLowerCase().includes(search) ||
          task.id.toLowerCase().includes(search) ||
          task.workerId.toLowerCase().includes(search)
      )
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, Math.min(500, Math.max(1, options.limit ?? 100)))
      .map(summarizeTask);
  }

  stats(): TaskStats {
    return taskStats(this.host?.listTasks() ?? []);
  }

  taskDetail(taskId: string): TaskDetail | undefined {
    const task = this.host?.getTask(taskId);
    if (!task) return undefined;
    return { task, events: this.monitor.events(taskId) };
  }

  async cancelTask(taskId: string): Promise<boolean> {
    if (!this.host || !this.isRunning) throw new ApiError(503, "Host 尚未运行");
    const task = this.host.getTask(taskId);
    if (!task) throw new ApiError(404, `任务 ${taskId} 不存在`);
    const cancelled = await this.host.cancelTask(taskId);
    if (!cancelled) throw new ApiError(409, "任务已经结束，无法取消");
    return true;
  }

  listConversations(): ManagedConversationSummary[] {
    const tasks = this.host?.listTasks() ?? [];
    const activeByConversation = new Map<string, number>();
    for (const task of tasks) {
      if (!ACTIVE_TASK_STATUSES.includes(task.status)) continue;
      const id = task.origin.conversationId;
      activeByConversation.set(id, (activeByConversation.get(id) ?? 0) + 1);
    }
    return this.chatStore.list().map((conversation) => ({
      ...conversation,
      activeTasks: activeByConversation.get(conversation.id) ?? 0,
    }));
  }

  getConversation(id: string): ConversationView {
    const conversation = this.chatStore.get(id);
    if (!conversation) throw new ApiError(404, "对话不存在");
    const activeTasks = (this.host?.listTasks() ?? [])
      .filter(
        (task) => task.origin.conversationId === id && ACTIVE_TASK_STATUSES.includes(task.status)
      )
      .map(summarizeTask);
    return { conversation, activeTasks };
  }

  async createConversation(title?: string): Promise<Conversation> {
    const conversation = await this.chatStore.create(title);
    this.publishConversations();
    return conversation;
  }

  async deleteConversation(id: string): Promise<boolean> {
    if (!this.chatStore.get(id)) throw new ApiError(404, "对话不存在");
    for (const task of this.host?.listTasks() ?? []) {
      if (task.origin.conversationId === id && ACTIVE_TASK_STATUSES.includes(task.status)) {
        await this.host?.cancelTask(task.id, "对话已删除");
      }
    }
    const deleted = await this.chatStore.delete(id);
    this.publishConversations();
    return deleted;
  }

  async sendChat(conversationId: string, rawContent: string): Promise<ConversationView> {
    if (!this.host || !this.isRunning) throw new ApiError(503, "Host 尚未运行或正在重启");
    if (!isModelConfigured(this.config)) {
      throw new ApiError(409, "模型尚未配置完成", { issues: configIssues(this.config) });
    }
    if (this.config.model.format !== "openai") {
      throw new ApiError(
        409,
        `${this.config.model.format} Provider 尚未实现，请使用 OpenAI 兼容接口`
      );
    }
    const content = rawContent.trim();
    if (!content) throw new ApiError(400, "消息不能为空");
    if (content.length > 100_000) throw new ApiError(400, "消息过长（上限 100000 字符）");
    const conversation = await this.chatStore.ensure(conversationId);
    const messageId = createId("web");
    await this.chatStore.appendUser(conversation.id, content, messageId);

    const message: InboundMessage = {
      id: messageId,
      externalId: messageId,
      channel: "web",
      conversationId: conversation.id,
      senderId: "web-user",
      content,
      kind: "message",
      receivedAt: new Date().toISOString(),
      metadata: { source: "web" },
    };
    try {
      await this.host.ingest(message);
    } catch (error) {
      throw new ApiError(503, `消息提交失败：${errorMessage(error)}`);
    }
    const summary = this.chatStore.summary(conversation.id);
    if (summary) this.hub.publish("conversation.updated", { conversation: summary });
    return this.getConversation(conversation.id);
  }

  validateConfig(input: unknown): { errors: string[]; warnings: string[]; issues: string[] } {
    const result = normalizeConfig(mergeConfigSecrets(input, this.config), { strict: true });
    return {
      errors: result.errors,
      warnings: result.warnings,
      issues: configIssues(result.config),
    };
  }

  async applyConfig(input: unknown): Promise<ApplyResult> {
    if (this.busy || this.applying) throw new ApiError(409, "配置正在应用，请稍候");
    const result = normalizeConfig(mergeConfigSecrets(input, this.config), { strict: true });
    if (result.errors.length > 0) {
      throw new ConfigValidationError("配置校验失败", result.errors, result.warnings);
    }
    const warnings = [...result.warnings];
    await this.activate(result.config, { persist: true, warnings });
    return {
      config: this.publicConfig(),
      secretStatus: this.secretStatus(),
      status: this.status(),
      warnings,
    };
  }

  getWebhookAdapter(channel: string): WebhookRoute | undefined {
    return this.runtime?.webhooks.find(
      (webhook) => webhook.channel === channel && webhook.active && webhook.adapter
    );
  }

  async testModel(input: unknown): Promise<{ ok: boolean; content?: string; error?: string }> {
    const source = asRecord(input) ?? {};
    const draft = asText(source.apiKey);
    const formatCandidate = asText(source.format) ?? this.config.model.format;
    const format =
      formatCandidate === "anthropic" || formatCandidate === "gemini" ? formatCandidate : "openai";
    const apiKey = draft || this.config.model.apiKey;
    const baseUrl = asText(source.baseUrl) || this.config.model.baseUrl;
    const model = asText(source.model) || this.config.model.model;
    if (!apiKey) throw new ApiError(400, "请先填写 API Key");
    if (!model) throw new ApiError(400, "请先填写模型名称");
    const provider = createProvider(format, apiKey, baseUrl || "https://api.openai.com/v1");
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("测试超时")), 20_000);
    let content = "";
    let error = "";
    try {
      for await (const chunk of provider.chatStream({
        model,
        messages: [
          { role: "system", content: "你是连接测试助手，只回复 OK。" },
          { role: "user", content: "ping" },
        ],
        tools: [],
        options: { temperature: 0, max_tokens: 16, signal: controller.signal },
      })) {
        if (chunk.type === "content") content += chunk.delta;
        if (chunk.type === "error") error += chunk.delta;
      }
    } catch (caught) {
      error = errorMessage(caught);
    } finally {
      clearTimeout(timer);
    }
    if (error) return { ok: false, error };
    return { ok: true, content: content.trim() || "(空响应)" };
  }

  async testIntegration(
    kind: string,
    input: unknown
  ): Promise<{ ok: boolean; label?: string; error?: string }> {
    if (!["github", "gitlab", "notion"].includes(kind)) {
      throw new ApiError(400, `未知集成：${kind}`);
    }
    const source = asRecord(input) ?? {};
    const draft = asText(source.token);
    const baseUrlDraft = asText(source.baseUrl);
    if (kind === "github") {
      const token = draft || this.config.integrations.github.token;
      if (!token) throw new ApiError(400, "请先填写 GitHub Token");
      const base = baseUrlDraft || this.config.integrations.github.apiBaseUrl;
      return this.probe(
        `${base}/user`,
        {
          authorization: `Bearer ${token}`,
          accept: "application/vnd.github+json",
        },
        (payload) => String(payload.login ?? payload.name ?? "GitHub")
      );
    }
    if (kind === "gitlab") {
      const token = draft || this.config.integrations.gitlab.token;
      if (!token) throw new ApiError(400, "请先填写 GitLab Token");
      const base = baseUrlDraft || this.config.integrations.gitlab.apiBaseUrl;
      return this.probe(`${base}/user`, { "private-token": token }, (payload) =>
        String(payload.username ?? payload.name ?? "GitLab")
      );
    }
    const token = draft || this.config.integrations.notion.token;
    if (!token) throw new ApiError(400, "请先填写 Notion Token");
    return this.probe(
      "https://api.notion.com/v1/users/me",
      {
        authorization: `Bearer ${token}`,
        "notion-version": "2022-06-28",
      },
      (payload) => String(payload.name ?? "Notion")
    );
  }

  async stop(): Promise<void> {
    if (this.unsubscribeHost) this.unsubscribeHost();
    this.unsubscribeHost = undefined;
    const runtime = this.runtime;
    this.host = undefined;
    this.runtime = undefined;
    if (runtime) {
      try {
        await runtime.host.stop();
      } catch (error) {
        this.logLine(`停止 Host 失败：${errorMessage(error)}`);
      }
      try {
        await runtime.dispose();
      } catch (error) {
        this.logLine(`释放运行时资源失败：${errorMessage(error)}`);
      }
    }
    this.state = "stopped";
    this.publishStatus();
  }

  private async activate(
    next: AppConfig,
    options: { persist: boolean; warnings: string[] }
  ): Promise<void> {
    if (this.busy) throw new ApiError(409, "已有配置操作正在进行");
    this.busy = true;
    this.applying = true;
    this.publishStatus();
    const previousConfig = this.config;
    const previousRuntime = this.runtime;
    let nextRuntime: RuntimeBuild | undefined;
    let previousStopped = false;
    try {
      nextRuntime = await buildRuntime(next, {
        hub: this.hub,
        chatStore: this.chatStore,
        log: this.logLine,
      });
      if (this.host) {
        this.detachHost();
        await previousRuntime?.host.stop();
        await previousRuntime?.dispose();
        previousStopped = previousRuntime !== undefined;
        this.host = undefined;
        this.runtime = undefined;
      }
      this.attachHost(nextRuntime);
      this.runtime = nextRuntime;
      this.host = nextRuntime.host;
      await nextRuntime.host.start();
      if (options.persist) await this.configStore.write(next);
      this.config = next;
      this.configWarnings = options.warnings;
      this.state = "running";
      this.startedAt = this.startedAt ?? new Date().toISOString();
      this.lastError = undefined;
      this.seedConversationMap();
      this.publishStatus();
      this.hub.publish("config.updated", {
        config: this.publicConfig(),
        secretStatus: this.secretStatus(),
        status: this.status(),
      });
    } catch (error) {
      this.lastError = errorMessage(error);
      this.logLine(`应用配置失败：${this.lastError}`);
      if (nextRuntime) {
        this.detachHost();
        try {
          await nextRuntime.host.stop();
          await nextRuntime.dispose();
        } catch {
          // 失败清理不覆盖原始错误。
        }
        this.host = undefined;
        this.runtime = undefined;
      }
      if (previousStopped && previousRuntime) {
        try {
          const restored = await buildRuntime(previousConfig, {
            hub: this.hub,
            chatStore: this.chatStore,
            log: this.logLine,
          });
          this.attachHost(restored);
          this.runtime = restored;
          this.host = restored.host;
          await restored.host.start();
          this.state = "running";
          this.seedConversationMap();
        } catch (restoreError) {
          this.host = undefined;
          this.runtime = undefined;
          this.state = "error";
          this.lastError = `${this.lastError}；恢复旧配置失败：${errorMessage(restoreError)}`;
        }
      } else if (!this.host) {
        this.state = "error";
      }
      throw error instanceof ConfigValidationError || error instanceof ApiError
        ? error
        : new ApiError(500, this.lastError);
    } finally {
      this.applying = false;
      this.busy = false;
      this.publishStatus();
    }
  }

  private attachHost(runtime: RuntimeBuild): void {
    this.unsubscribeHost = runtime.host.subscribe((event) => this.onHostEvent(event));
  }

  private detachHost(): void {
    if (this.unsubscribeHost) this.unsubscribeHost();
    this.unsubscribeHost = undefined;
  }

  private seedConversationMap(): void {
    this.taskConversations.clear();
    for (const task of this.host?.listTasks() ?? []) {
      this.taskConversations.set(task.id, task.origin.conversationId);
    }
  }

  private onHostEvent(event: HostEvent): void {
    if (event.type === "task.updated") {
      const task = event.task;
      this.monitor.recordTask(task);
      this.taskConversations.set(task.id, task.origin.conversationId);
      this.hub.publish("task.updated", summarizeTask(task));
      return;
    }
    if (event.type === "worker.event") {
      this.monitor.recordEvent(event.event);
      const conversationId = this.conversationFor(event.event.taskId);
      this.hub.publish("worker.event", {
        ...event.event,
        ...(conversationId ? { conversationId } : {}),
      });
      return;
    }
    if (event.type === "message.sent") {
      this.hub.publish("message.sent", {
        message: event.message,
        conversationId: event.message.channel === "web" ? event.message.conversationId : undefined,
      });
      return;
    }
    if (event.type === "message.accepted") {
      this.hub.publish("message.accepted", {
        conversationId: event.message.conversationId,
        channel: event.message.channel,
      });
      return;
    }
    this.lastError = event.error.message;
    this.logLine(`Host 错误：${event.error.message}`);
    this.hub.publish("error", { message: event.error.message });
  }

  private conversationFor(taskId: string): string | undefined {
    const cached = this.taskConversations.get(taskId);
    if (cached) return cached;
    const task = this.host?.getTask(taskId);
    if (!task) return undefined;
    this.taskConversations.set(task.id, task.origin.conversationId);
    return task.origin.conversationId;
  }

  private publishStatus(): void {
    this.hub.publish("status", this.status());
  }

  private publishConversations(): void {
    this.hub.publish("conversations.changed", { conversations: this.listConversations() });
  }

  private async probe(
    url: string,
    headers: Record<string, string>,
    label: (payload: Record<string, unknown>) => string
  ): Promise<{ ok: boolean; label?: string; error?: string }> {
    try {
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(15_000),
      });
      const text = await response.text();
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}: ${text.slice(0, 300)}` };
      }
      let payload: unknown;
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        return { ok: false, error: "响应不是 JSON" };
      }
      return { ok: true, label: label(asRecord(payload) ?? {}) };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }
}
