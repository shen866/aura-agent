import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { MemoryPolicy, ReasoningEffort, WorkerOutputFormat } from "@aura/protocol";

export type ApiFormat = "openai" | "anthropic" | "gemini";

export interface ModelSettings {
  format: ApiFormat;
  apiKey: string;
  baseUrl: string;
  model: string;
  /** 为空时复用 model。 */
  routerModel: string;
  defaultTemperature: number;
  defaultTopP: number;
}

export interface RouterSettings {
  defaultWorkerId: string;
  defaultMaxAttempts: number;
  retryDelayMs: number;
  notifyProgress: boolean;
  useLlmForWorkerEvents: boolean;
  plannerTimeoutMs: number;
  batchIntervalMs: number;
  maxBatchSize: number;
  maxConcurrentTasks: number;
  stopTimeoutMs: number;
  outboxRetryMs: number;
  /** 高级路由规则，保持 JSON 形态，交给 BatchRouter 校验。 */
  rules: Record<string, unknown>[];
}

export interface ToolPolicySettings {
  allow: string[];
  deny: string[];
}

export interface GenerationSettings {
  temperature: number | null;
  topP: number | null;
  maxTokens: number | null;
}

export interface WorkerSettings {
  id: string;
  description: string;
  capabilities: string[];
  /** 为空时使用全局模型。 */
  model: string;
  reasoningEffort: "" | ReasoningEffort;
  outputFormat: WorkerOutputFormat;
  /** 为空时使用内置系统提示词。 */
  systemPrompt: string;
  tools: ToolPolicySettings;
  memory: MemoryPolicy;
  generation: GenerationSettings;
}

export interface GitHubSettings {
  enabled: boolean;
  token: string;
  webhookSecret: string;
  apiBaseUrl: string;
}

export interface GitLabSettings {
  enabled: boolean;
  token: string;
  webhookToken: string;
  apiBaseUrl: string;
}

export interface NotionSettings {
  enabled: boolean;
  token: string;
  databaseId: string;
  pollIntervalMs: number;
  initialCursor: string;
  cursorPath: string;
}

export interface IntegrationSettings {
  github: GitHubSettings;
  gitlab: GitLabSettings;
  notion: NotionSettings;
}

export interface McpServerSetting {
  name: string;
  transport: "stdio" | "http" | "https";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
}

export interface DataSettings {
  hostStatePath: string;
  memoryPath: string;
  /** 为空表示不加载 skills。 */
  skillsPath: string;
  memoryLimit: number;
  maxMemories: number;
  mcpServers: McpServerSetting[];
}

export interface AppConfig {
  version: 1;
  model: ModelSettings;
  router: RouterSettings;
  workers: WorkerSettings[];
  integrations: IntegrationSettings;
  data: DataSettings;
}

export interface ConfigResult {
  config: AppConfig;
  errors: string[];
  warnings: string[];
}

export const SECRET_PATHS = [
  "model.apiKey",
  "integrations.github.token",
  "integrations.github.webhookSecret",
  "integrations.gitlab.token",
  "integrations.gitlab.webhookToken",
  "integrations.notion.token",
] as const;

export type SecretPath = (typeof SECRET_PATHS)[number];

export interface SecretState {
  set: boolean;
  hint: string;
}

export type SecretStatus = Record<SecretPath, SecretState>;

export function defaultConfig(): AppConfig {
  return {
    version: 1,
    model: {
      format: "openai",
      apiKey: "",
      baseUrl: "https://api.openai.com/v1",
      model: "",
      routerModel: "",
      defaultTemperature: 0.7,
      defaultTopP: 1,
    },
    router: {
      defaultWorkerId: "general",
      defaultMaxAttempts: 2,
      retryDelayMs: 1000,
      notifyProgress: false,
      useLlmForWorkerEvents: false,
      plannerTimeoutMs: 15000,
      batchIntervalMs: 300,
      maxBatchSize: 20,
      maxConcurrentTasks: 4,
      stopTimeoutMs: 5000,
      outboxRetryMs: 2000,
      rules: [],
    },
    workers: [
      {
        id: "general",
        description: "通用对话、工具调用与事务处理",
        capabilities: ["chat", "code", "tools"],
        model: "",
        reasoningEffort: "medium",
        outputFormat: "text",
        systemPrompt: "",
        tools: { allow: [], deny: [] },
        memory: { read: true, write: true },
        generation: { temperature: null, topP: null, maxTokens: null },
      },
    ],
    integrations: {
      github: {
        enabled: false,
        token: "",
        webhookSecret: "",
        apiBaseUrl: "https://api.github.com",
      },
      gitlab: {
        enabled: false,
        token: "",
        webhookToken: "",
        apiBaseUrl: "https://gitlab.com/api/v4",
      },
      notion: {
        enabled: false,
        token: "",
        databaseId: "",
        pollIntervalMs: 30000,
        initialCursor: "",
        cursorPath: "data/notion-cursor",
      },
    },
    data: {
      hostStatePath: "data/host-state.json",
      memoryPath: "data/memories.json",
      skillsPath: "",
      memoryLimit: 5,
      maxMemories: 500,
      mcpServers: [],
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asText(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    return ["1", "true", "yes", "on"].includes(value.toLowerCase());
  }
  return fallback;
}

function asStringList(value: unknown): string[] {
  const raw = typeof value === "string" ? value.split(",") : value;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.map((item) => String(item).trim()).filter(Boolean))];
}

function asOptionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(
  value: unknown,
  fallback: number,
  label: string,
  warnings: string[],
  min: number,
  max: number,
  integer = true
): number {
  if (value === undefined || value === null || value === "") return fallback;
  const candidate =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(candidate)) {
    warnings.push(`${label} 不是有效数字，已使用 ${fallback}`);
    return fallback;
  }
  const rounded = integer ? Math.round(candidate) : candidate;
  if (rounded < min || rounded > max) {
    const clamped = Math.min(max, Math.max(min, rounded));
    warnings.push(`${label} 超出范围（${min}-${max}），已调整为 ${clamped}`);
    return clamped;
  }
  return rounded;
}

function nullableNumber(
  value: unknown,
  label: string,
  warnings: string[],
  min: number,
  max: number
): number | null {
  if (value === undefined || value === null || value === "") return null;
  const candidate = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(candidate)) {
    warnings.push(`${label} 不是有效数字，已留空`);
    return null;
  }
  if (candidate < min || candidate > max) {
    const clamped = Math.min(max, Math.max(min, candidate));
    warnings.push(`${label} 超出范围（${min}-${max}），已调整为 ${clamped}`);
    return clamped;
  }
  return candidate;
}

function normalizeHttpUrl(
  value: unknown,
  fallback: string,
  label: string,
  errors: string[],
  warnings: string[],
  strict: boolean
): string {
  const text = asText(value, fallback);
  if (!text) {
    if (strict) errors.push(`${label} 不能为空`);
    return fallback;
  }
  try {
    const url = new URL(text);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("只支持 http/https");
    return text.replace(/\/+$/, "");
  } catch (error) {
    const message = `${label} 不是有效的 http(s) URL：${error instanceof Error ? error.message : String(error)}`;
    if (strict) errors.push(message);
    else warnings.push(message);
    return fallback;
  }
}

function normalizeModel(
  raw: unknown,
  errors: string[],
  warnings: string[],
  strict: boolean
): ModelSettings {
  const defaults = defaultConfig().model;
  const source = asRecord(raw) ?? {};
  const formatCandidate = asText(source.format, defaults.format) as ApiFormat;
  const formats: ApiFormat[] = ["openai", "anthropic", "gemini"];
  const format = formats.includes(formatCandidate) ? formatCandidate : defaults.format;
  if (!formats.includes(formatCandidate)) {
    const message = `模型格式必须是 ${formats.join("/")} 之一`;
    if (strict) errors.push(message);
    else warnings.push(message);
  }
  const baseUrl = normalizeHttpUrl(
    source.baseUrl,
    defaults.baseUrl,
    "模型 Base URL",
    errors,
    warnings,
    strict
  );
  return {
    format,
    apiKey: asText(source.apiKey),
    baseUrl,
    model: asText(source.model),
    routerModel: asText(source.routerModel),
    defaultTemperature: numberValue(
      source.defaultTemperature,
      defaults.defaultTemperature,
      "默认 temperature",
      warnings,
      0,
      2,
      false
    ),
    defaultTopP: numberValue(
      source.defaultTopP,
      defaults.defaultTopP,
      "默认 top_p",
      warnings,
      0,
      2,
      false
    ),
  };
}

function normalizeRules(
  raw: unknown,
  workerIds: string[],
  errors: string[],
  warnings: string[],
  strict: boolean
): Record<string, unknown>[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("router.rules 必须是数组，已忽略");
    return [];
  }
  const rules: Record<string, unknown>[] = [];
  raw.forEach((candidate, index) => {
    const source = asRecord(candidate);
    const label = `Router 规则 #${index + 1}`;
    if (!source) {
      const message = `${label} 必须是对象`;
      if (strict) errors.push(message);
      else warnings.push(`${message}，已忽略`);
      return;
    }
    const match = asRecord(source.match);
    const decision = asRecord(source.decision);
    if (!match) {
      const message = `${label} 缺少 match 对象`;
      if (strict) errors.push(message);
      else warnings.push(`${message}，已忽略`);
      return;
    }
    if (!decision) {
      const message = `${label} 缺少 decision 对象`;
      if (strict) errors.push(message);
      else warnings.push(`${message}，已忽略`);
      return;
    }
    const decisionType = asText(decision.type);
    if (!["dispatch", "reply", "ignore"].includes(decisionType)) {
      const message = `${label} 的 decision.type 必须是 dispatch/reply/ignore`;
      if (strict) errors.push(message);
      else warnings.push(`${message}，已忽略`);
      return;
    }
    if (decisionType === "reply" && !asText(decision.content)) {
      const message = `${label} 的 reply 必须包含 content`;
      if (strict) errors.push(message);
      else warnings.push(`${message}，已忽略`);
      return;
    }
    if (decisionType === "dispatch" && asText(decision.workerId)) {
      const workerId = asText(decision.workerId)!;
      if (!workerIds.includes(workerId) && !Array.isArray(decision.requiredCapabilities)) {
        warnings.push(`${label} 指定了未知 worker "${workerId}"，运行时可能无法分派`);
      }
    }
    const pattern = asText(match.pattern);
    const flags = asText(match.flags);
    if (pattern) {
      try {
        new RegExp(pattern, flags);
      } catch (error) {
        const message = `${label} 的 match.pattern 无效：${
          error instanceof Error ? error.message : String(error)
        }`;
        if (strict) errors.push(message);
        else warnings.push(`${message}，已忽略`);
        return;
      }
    }
    const name = asText(source.name) || `rule-${index + 1}`;
    rules.push({
      ...source,
      name,
      match: {
        ...(asText(match.channel) ? { channel: asText(match.channel) } : {}),
        ...(asText(match.kind) ? { kind: asText(match.kind) } : {}),
        ...(asText(match.senderId) ? { senderId: asText(match.senderId) } : {}),
        ...(pattern ? { pattern } : {}),
        ...(flags ? { flags } : {}),
      },
      decision: {
        ...decision,
        type: decisionType,
      },
    });
  });
  return rules;
}

function normalizeRouter(
  raw: unknown,
  workerIds: string[],
  errors: string[],
  warnings: string[],
  strict: boolean
): RouterSettings {
  const defaults = defaultConfig().router;
  const source = asRecord(raw) ?? {};
  const rules = normalizeRules(source.rules, workerIds, errors, warnings, strict);
  const requestedDefault = asText(source.defaultWorkerId);
  let defaultWorkerId = requestedDefault || workerIds[0] || "";
  if (requestedDefault && !workerIds.includes(requestedDefault)) {
    const message = `默认 worker "${requestedDefault}" 不在 worker 列表中`;
    if (strict) errors.push(message);
    else warnings.push(message);
    defaultWorkerId = workerIds[0] ?? "";
  }
  return {
    defaultWorkerId,
    defaultMaxAttempts: numberValue(
      source.defaultMaxAttempts,
      defaults.defaultMaxAttempts,
      "默认最大尝试次数",
      warnings,
      1,
      10
    ),
    retryDelayMs: numberValue(
      source.retryDelayMs,
      defaults.retryDelayMs,
      "重试延迟",
      warnings,
      0,
      60000
    ),
    notifyProgress: asBoolean(source.notifyProgress, defaults.notifyProgress),
    useLlmForWorkerEvents: asBoolean(source.useLlmForWorkerEvents, defaults.useLlmForWorkerEvents),
    plannerTimeoutMs: numberValue(
      source.plannerTimeoutMs,
      defaults.plannerTimeoutMs,
      "Router LLM 超时",
      warnings,
      1000,
      120000
    ),
    batchIntervalMs: numberValue(
      source.batchIntervalMs,
      defaults.batchIntervalMs,
      "输入批处理窗口",
      warnings,
      10,
      10000
    ),
    maxBatchSize: numberValue(
      source.maxBatchSize,
      defaults.maxBatchSize,
      "最大批量",
      warnings,
      1,
      500
    ),
    maxConcurrentTasks: numberValue(
      source.maxConcurrentTasks,
      defaults.maxConcurrentTasks,
      "最大并发任务",
      warnings,
      1,
      64
    ),
    stopTimeoutMs: numberValue(
      source.stopTimeoutMs,
      defaults.stopTimeoutMs,
      "停止超时",
      warnings,
      0,
      120000
    ),
    outboxRetryMs: numberValue(
      source.outboxRetryMs,
      defaults.outboxRetryMs,
      "outbox 重试间隔",
      warnings,
      100,
      60000
    ),
    rules,
  };
}

function normalizeWorker(
  raw: unknown,
  index: number,
  errors: string[],
  warnings: string[],
  strict: boolean
): WorkerSettings {
  const source = asRecord(raw) ?? {};
  const fallbackId = `worker-${index + 1}`;
  const id = asText(source.id, fallbackId);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(id)) {
    const message = `worker id "${id}" 只能包含字母、数字、下划线或连字符，且长度为 1-64`;
    if (strict) errors.push(message);
    else warnings.push(message);
  }
  const tools = asRecord(source.tools) ?? {};
  const memory = asRecord(source.memory) ?? {};
  const generation = asRecord(source.generation) ?? {};
  const effortCandidate = asText(source.reasoningEffort);
  const efforts: Array<"" | ReasoningEffort> = ["", "low", "medium", "high"];
  const reasoningEffort = efforts.includes(effortCandidate as ReasoningEffort | "")
    ? (effortCandidate as "" | ReasoningEffort)
    : ("" as const);
  if (!efforts.includes(effortCandidate as ReasoningEffort | "")) {
    warnings.push(`worker "${id}" 的 reasoningEffort 无效，已留空`);
  }
  const outputCandidate = asText(source.outputFormat);
  const outputFormat: WorkerOutputFormat =
    outputCandidate === "json" || outputCandidate === "text" ? outputCandidate : "text";
  if (outputCandidate && outputCandidate !== outputFormat) {
    warnings.push(`worker "${id}" 的 outputFormat 无效，已使用 text`);
  }
  return {
    id,
    description: asText(source.description) || `Worker ${id}`,
    capabilities: asStringList(source.capabilities).length
      ? asStringList(source.capabilities)
      : ["chat"],
    model: asText(source.model),
    reasoningEffort,
    outputFormat,
    systemPrompt: asText(source.systemPrompt),
    tools: {
      allow: asStringList(tools.allow),
      deny: asStringList(tools.deny),
    },
    memory: {
      read: asBoolean(memory.read, true),
      write: asBoolean(memory.write, true),
    },
    generation: {
      temperature: nullableNumber(
        generation.temperature,
        `worker "${id}" temperature`,
        warnings,
        0,
        2
      ),
      topP: nullableNumber(generation.topP, `worker "${id}" top_p`, warnings, 0, 2),
      maxTokens: nullableNumber(
        generation.maxTokens,
        `worker "${id}" max_tokens`,
        warnings,
        1,
        32768
      ),
    },
  };
}

function normalizeWorkers(
  raw: unknown,
  errors: string[],
  warnings: string[],
  strict: boolean
): WorkerSettings[] {
  const defaults = defaultConfig().workers;
  if (!Array.isArray(raw) || raw.length === 0) {
    const message = "至少需要一个 worker";
    if (strict) errors.push(message);
    else if (raw !== undefined) warnings.push(`${message}，已恢复默认 worker`);
    return defaults;
  }
  const workers = raw.map((worker, index) =>
    normalizeWorker(worker, index, errors, warnings, strict)
  );
  const seen = new Set<string>();
  const unique: WorkerSettings[] = [];
  for (const worker of workers) {
    let id = worker.id;
    while (seen.has(id)) {
      const message = `worker id "${id}" 重复`;
      if (strict) errors.push(message);
      else warnings.push(`${message}，已自动改名`);
      id = `${worker.id}-${unique.length + 1}`;
    }
    seen.add(id);
    unique.push(id === worker.id ? worker : { ...worker, id });
  }
  return unique;
}

function normalizeGithub(
  raw: unknown,
  errors: string[],
  warnings: string[],
  strict: boolean
): GitHubSettings {
  const defaults = defaultConfig().integrations.github;
  const source = asRecord(raw) ?? {};
  const enabled = asBoolean(source.enabled, defaults.enabled);
  const token = asText(source.token);
  const webhookSecret = asText(source.webhookSecret);
  if (enabled && !token) {
    const message = "启用 GitHub 需要 Token";
    if (strict) errors.push(message);
    else warnings.push(`${message}，渠道将不会启动`);
  }
  if (enabled && !webhookSecret) {
    const message = "启用 GitHub 需要 Webhook Secret";
    if (strict) errors.push(message);
    else warnings.push(`${message}，渠道将不会启动`);
  }
  return {
    enabled,
    token,
    webhookSecret,
    apiBaseUrl: normalizeHttpUrl(
      source.apiBaseUrl,
      defaults.apiBaseUrl,
      "GitHub API Base URL",
      errors,
      warnings,
      strict
    ),
  };
}

function normalizeGitlab(
  raw: unknown,
  errors: string[],
  warnings: string[],
  strict: boolean
): GitLabSettings {
  const defaults = defaultConfig().integrations.gitlab;
  const source = asRecord(raw) ?? {};
  const enabled = asBoolean(source.enabled, defaults.enabled);
  const token = asText(source.token);
  const webhookToken = asText(source.webhookToken);
  if (enabled && !token) {
    const message = "启用 GitLab 需要 Token";
    if (strict) errors.push(message);
    else warnings.push(`${message}，渠道将不会启动`);
  }
  if (enabled && !webhookToken) {
    const message = "启用 GitLab 需要 Webhook Token";
    if (strict) errors.push(message);
    else warnings.push(`${message}，渠道将不会启动`);
  }
  return {
    enabled,
    token,
    webhookToken,
    apiBaseUrl: normalizeHttpUrl(
      source.apiBaseUrl,
      defaults.apiBaseUrl,
      "GitLab API Base URL",
      errors,
      warnings,
      strict
    ),
  };
}

function normalizeNotion(
  raw: unknown,
  errors: string[],
  warnings: string[],
  strict: boolean
): NotionSettings {
  const defaults = defaultConfig().integrations.notion;
  const source = asRecord(raw) ?? {};
  const enabled = asBoolean(source.enabled, defaults.enabled);
  const token = asText(source.token);
  const databaseId = asText(source.databaseId);
  if (enabled && !token) {
    const message = "启用 Notion 需要 Integration Token";
    if (strict) errors.push(message);
    else warnings.push(`${message}，渠道将不会启动`);
  }
  if (enabled && !databaseId) {
    const message = "启用 Notion 需要 Database ID";
    if (strict) errors.push(message);
    else warnings.push(`${message}，渠道将不会启动`);
  }
  const initialCursor = asText(source.initialCursor);
  if (initialCursor && Number.isNaN(new Date(initialCursor).getTime())) {
    const message = "Notion 初始游标不是有效时间";
    if (strict) errors.push(message);
    else warnings.push(message);
  }
  return {
    enabled,
    token,
    databaseId,
    pollIntervalMs: numberValue(
      source.pollIntervalMs,
      defaults.pollIntervalMs,
      "Notion 轮询间隔",
      warnings,
      5000,
      3600000
    ),
    initialCursor,
    cursorPath: asText(source.cursorPath, defaults.cursorPath) || defaults.cursorPath,
  };
}

function normalizeMcpServers(
  raw: unknown,
  errors: string[],
  warnings: string[],
  strict: boolean
): McpServerSetting[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    warnings.push("MCP 服务器配置必须是数组，已忽略");
    return [];
  }
  const servers: McpServerSetting[] = [];
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    const source = asRecord(entry);
    if (!source) {
      warnings.push(`忽略无效 MCP 服务器配置 #${index + 1}`);
      return;
    }
    const name = asText(source.name, `mcp-${index + 1}`);
    if (seen.has(name)) {
      const message = `MCP 服务器名称 "${name}" 重复`;
      if (strict) errors.push(message);
      else warnings.push(`${message}，已忽略`);
      return;
    }
    const transportCandidate = asText(source.transport, "stdio");
    const transport: McpServerSetting["transport"] =
      transportCandidate === "http" || transportCandidate === "https"
        ? transportCandidate
        : "stdio";
    if (!["stdio", "http", "https"].includes(transportCandidate)) {
      warnings.push(`MCP 服务器 "${name}" 传输方式无效，已使用 stdio`);
    }
    const command = asOptionalText(source.command);
    const url = asOptionalText(source.url);
    if (transport === "stdio" && !command) {
      const message = `MCP 服务器 "${name}" 使用 stdio 时必须配置 command`;
      if (strict) errors.push(message);
      else warnings.push(`${message}，已忽略`);
      return;
    }
    if (transport !== "stdio" && !url) {
      const message = `MCP 服务器 "${name}" 使用 ${transport} 时必须配置 url`;
      if (strict) errors.push(message);
      else warnings.push(`${message}，已忽略`);
      return;
    }
    if (url) {
      try {
        new URL(url);
      } catch {
        const message = `MCP 服务器 "${name}" 的 url 无效`;
        if (strict) errors.push(message);
        else warnings.push(`${message}，已忽略`);
        return;
      }
    }
    const envSource = asRecord(source.env);
    const env = envSource
      ? Object.fromEntries(
          Object.entries(envSource).map(([key, value]) => [key, String(value ?? "")])
        )
      : undefined;
    seen.add(name);
    servers.push({
      name,
      transport,
      ...(command !== undefined ? { command } : {}),
      ...(Array.isArray(source.args) ? { args: source.args.map(String) } : {}),
      ...(asOptionalText(source.cwd) !== undefined ? { cwd: asOptionalText(source.cwd)! } : {}),
      ...(url !== undefined ? { url } : {}),
      ...(env !== undefined ? { env } : {}),
    });
  });
  return servers;
}

function normalizeData(
  raw: unknown,
  errors: string[],
  warnings: string[],
  strict: boolean
): DataSettings {
  const defaults = defaultConfig().data;
  const source = asRecord(raw) ?? {};
  const hostStatePath = asText(source.hostStatePath, defaults.hostStatePath);
  if (!hostStatePath) {
    const message = "Host 状态文件路径不能为空";
    if (strict) errors.push(message);
    else warnings.push(`${message}，已使用默认值`);
  }
  const memoryPath = asText(source.memoryPath, defaults.memoryPath) || defaults.memoryPath;
  return {
    hostStatePath: hostStatePath || defaults.hostStatePath,
    memoryPath,
    skillsPath: asText(source.skillsPath),
    memoryLimit: numberValue(
      source.memoryLimit,
      defaults.memoryLimit,
      "记忆检索条数",
      warnings,
      1,
      20
    ),
    maxMemories: numberValue(
      source.maxMemories,
      defaults.maxMemories,
      "最大记忆条数",
      warnings,
      10,
      5000
    ),
    mcpServers: normalizeMcpServers(source.mcpServers, errors, warnings, strict),
  };
}

/**
 * 将任意输入收敛为可运行的配置。
 * strict=true 用于保存/应用：结构错误会阻止提交；strict=false 用于加载：尽量修复并给 warning。
 */
export function normalizeConfig(raw: unknown, options: { strict?: boolean } = {}): ConfigResult {
  const strict = options.strict ?? false;
  const errors: string[] = [];
  const warnings: string[] = [];
  const source = asRecord(raw) ?? {};
  if (!asRecord(raw)) {
    warnings.push("配置不是 JSON 对象，已使用默认值");
  }

  const workers = normalizeWorkers(source.workers, errors, warnings, strict);
  const router = normalizeRouter(
    source.router,
    workers.map((worker) => worker.id),
    errors,
    warnings,
    strict
  );
  const integrationsSource = asRecord(source.integrations) ?? {};
  const integrations: IntegrationSettings = {
    github: normalizeGithub(integrationsSource.github, errors, warnings, strict),
    gitlab: normalizeGitlab(integrationsSource.gitlab, errors, warnings, strict),
    notion: normalizeNotion(integrationsSource.notion, errors, warnings, strict),
  };
  const config: AppConfig = {
    version: 1,
    model: normalizeModel(source.model, errors, warnings, strict),
    router,
    workers,
    integrations,
    data: normalizeData(source.data, errors, warnings, strict),
  };
  return { config, errors, warnings };
}

export function getPathValue(source: unknown, dottedPath: string): unknown {
  let current: unknown = source;
  for (const segment of dottedPath.split(".")) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}

function setPathValue(target: Record<string, unknown>, dottedPath: string, value: unknown): void {
  const segments = dottedPath.split(".");
  let current: Record<string, unknown> = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const next = asRecord(current[segment]) ?? {};
    current[segment] = next;
    current = next;
  }
  current[segments.at(-1)!] = value;
}

/**
 * 把页面未提交的 secret 字段沿用旧值。
 * undefined / 空字符串表示“未修改”；显式 null 表示清除（页面清除按钮使用 null）。
 * 这样 GET 返回的脱敏配置可以直接回传，不会意外清空已保存的 token。
 */
export function mergeConfigSecrets(input: unknown, current: AppConfig): unknown {
  const root = asRecord(input);
  if (!root) return input;
  const clone = structuredClone(root);
  for (const secretPath of SECRET_PATHS) {
    const incoming = getPathValue(clone, secretPath);
    if (incoming === undefined || incoming === "") {
      setPathValue(clone, secretPath, getPathValue(current, secretPath) ?? "");
    } else if (incoming === null) {
      setPathValue(clone, secretPath, "");
    }
  }
  return clone;
}

export function publicConfig(config: AppConfig): AppConfig {
  const clone = structuredClone(config);
  for (const secretPath of SECRET_PATHS)
    setPathValue(clone as unknown as Record<string, unknown>, secretPath, "");
  return clone;
}

export function getSecretStatus(config: AppConfig): SecretStatus {
  const status = {} as SecretStatus;
  for (const secretPath of SECRET_PATHS) {
    const value = getPathValue(config, secretPath);
    const text = typeof value === "string" ? value : "";
    status[secretPath] = {
      set: text.length > 0,
      hint: text.length > 0 ? `••••${text.slice(-4)}` : "",
    };
  }
  return status;
}

export function isModelConfigured(config: AppConfig): boolean {
  const model = config.model;
  return Boolean(model.apiKey && model.model && (model.format !== "openai" || model.baseUrl));
}

/** 面向用户的可操作问题列表；不阻止启动，但会阻止对话。 */
export function configIssues(config: AppConfig): string[] {
  const issues: string[] = [];
  if (!config.model.apiKey) issues.push("尚未配置模型 API Key");
  if (!config.model.model) issues.push("尚未配置模型名称");
  if (config.model.format === "openai" && !config.model.baseUrl) {
    issues.push("尚未配置模型 Base URL");
  }
  if (config.model.format !== "openai") {
    issues.push(`${config.model.format} Provider 尚未实现，请使用 OpenAI 兼容接口`);
  }
  if (!config.workers.some((worker) => worker.id === config.router.defaultWorkerId)) {
    issues.push("默认 worker 不在 worker 列表中");
  }
  const github = config.integrations.github;
  if (github.enabled && (!github.token || !github.webhookSecret)) {
    issues.push("GitHub 渠道已启用但缺少 Token 或 Webhook Secret");
  }
  const gitlab = config.integrations.gitlab;
  if (gitlab.enabled && (!gitlab.token || !gitlab.webhookToken)) {
    issues.push("GitLab 渠道已启用但缺少 Token 或 Webhook Token");
  }
  const notion = config.integrations.notion;
  if (notion.enabled && (!notion.token || !notion.databaseId)) {
    issues.push("Notion 渠道已启用但缺少 Token 或 Database ID");
  }
  return issues;
}

export class FileConfigStore {
  constructor(private readonly filePath: string) {}

  get path(): string {
    return this.filePath;
  }

  async read(): Promise<unknown | undefined> {
    try {
      return JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new Error(
        `读取配置文件失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  async write(config: AppConfig): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(config, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath);
  }
}
