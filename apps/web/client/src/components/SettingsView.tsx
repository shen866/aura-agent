import { useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { api, ApiFailure } from "../api";
import { useToast } from "../toast";
import type {
  AppConfig,
  AppStatus,
  ApplyConfigResult,
  ConfigResult,
  SecretPath,
  SecretStatus,
  ValidationResult,
} from "../types";
import { Icon } from "./Icon";
import {
  CheckField,
  Field,
  SecretField,
  SectionHeader,
  SelectField,
  WebhookBox,
} from "./SettingsFields";

export interface SettingsViewProps {
  app: AppStatus | null;
  config: AppConfig | null;
  secretStatus: SecretStatus;
  visible: boolean;
  onApplied: (result: ApplyConfigResult) => void;
  onReloaded: (result: ConfigResult) => void;
}

type IntegrationKind = "github" | "gitlab" | "notion";
type WorkerConfig = AppConfig["workers"][number];

interface ModelDraft {
  format: AppConfig["model"]["format"];
  model: string;
  baseUrl: string;
  routerModel: string;
  defaultTemperature: string;
  defaultTopP: string;
}

interface RouterDraft {
  defaultWorkerId: string;
  defaultMaxAttempts: string;
  retryDelayMs: string;
  plannerTimeoutMs: string;
  batchIntervalMs: string;
  maxBatchSize: string;
  maxConcurrentTasks: string;
  stopTimeoutMs: string;
  outboxRetryMs: string;
  notifyProgress: boolean;
  useLlmForWorkerEvents: boolean;
}

interface WorkerDraft {
  id: string;
  description: string;
  capabilities: string;
  model: string;
  reasoningEffort: WorkerConfig["reasoningEffort"];
  outputFormat: WorkerConfig["outputFormat"];
  systemPrompt: string;
  toolsAllow: string;
  toolsDeny: string;
  memoryRead: boolean;
  memoryWrite: boolean;
  temperature: string;
  topP: string;
  maxTokens: string;
}

interface GitHubDraft {
  enabled: boolean;
  apiBaseUrl: string;
}

interface GitLabDraft {
  enabled: boolean;
  apiBaseUrl: string;
}

interface NotionDraft {
  enabled: boolean;
  databaseId: string;
  pollIntervalMs: string;
  initialCursor: string;
  cursorPath: string;
}

interface IntegrationDraft {
  github: GitHubDraft;
  gitlab: GitLabDraft;
  notion: NotionDraft;
}

interface DataDraft {
  hostStatePath: string;
  memoryPath: string;
  skillsPath: string;
  memoryLimit: string;
  maxMemories: string;
}

interface SettingsDraft {
  version: AppConfig["version"];
  model: ModelDraft;
  router: RouterDraft;
  workers: WorkerDraft[];
  integrations: IntegrationDraft;
  data: DataDraft;
}

interface JsonDraft {
  mcpServers: string;
  routerRules: string;
}

type AlertType = "info" | "warn" | "error";

const SECRET_PATHS: readonly SecretPath[] = [
  "model.apiKey",
  "integrations.github.token",
  "integrations.github.webhookSecret",
  "integrations.gitlab.token",
  "integrations.gitlab.webhookToken",
  "integrations.notion.token",
];

const ROUTER_RULE_HINT =
  '高优先级规则优先匹配，例如 {"name":"代码任务","priority":10,"match":{"pattern":"^/code","kind":"message"},"decision":{"type":"dispatch","workerId":"coder"}}。';

function emptySecretValues(): Record<SecretPath, string> {
  const values = {} as Record<SecretPath, string>;
  for (const path of SECRET_PATHS) values[path] = "";
  return values;
}

function nullableNumberText(value: number | null): string {
  return value === null ? "" : String(value);
}

function createDraft(config: AppConfig): SettingsDraft {
  return {
    version: config.version,
    model: {
      format: config.model.format,
      model: config.model.model,
      baseUrl: config.model.baseUrl,
      routerModel: config.model.routerModel,
      defaultTemperature: String(config.model.defaultTemperature),
      defaultTopP: String(config.model.defaultTopP),
    },
    router: {
      defaultWorkerId: config.router.defaultWorkerId,
      defaultMaxAttempts: String(config.router.defaultMaxAttempts),
      retryDelayMs: String(config.router.retryDelayMs),
      plannerTimeoutMs: String(config.router.plannerTimeoutMs),
      batchIntervalMs: String(config.router.batchIntervalMs),
      maxBatchSize: String(config.router.maxBatchSize),
      maxConcurrentTasks: String(config.router.maxConcurrentTasks),
      stopTimeoutMs: String(config.router.stopTimeoutMs),
      outboxRetryMs: String(config.router.outboxRetryMs),
      notifyProgress: config.router.notifyProgress,
      useLlmForWorkerEvents: config.router.useLlmForWorkerEvents,
    },
    workers: config.workers.map((worker) => ({
      id: worker.id,
      description: worker.description,
      capabilities: (worker.capabilities ?? []).join(", "),
      model: worker.model,
      reasoningEffort: worker.reasoningEffort,
      outputFormat: worker.outputFormat,
      systemPrompt: worker.systemPrompt,
      toolsAllow: (worker.tools?.allow ?? []).join(", "),
      toolsDeny: (worker.tools?.deny ?? []).join(", "),
      memoryRead: worker.memory?.read ?? false,
      memoryWrite: worker.memory?.write ?? false,
      temperature: nullableNumberText(worker.generation?.temperature ?? null),
      topP: nullableNumberText(worker.generation?.topP ?? null),
      maxTokens: nullableNumberText(worker.generation?.maxTokens ?? null),
    })),
    integrations: {
      github: {
        enabled: config.integrations.github.enabled,
        apiBaseUrl: config.integrations.github.apiBaseUrl,
      },
      gitlab: {
        enabled: config.integrations.gitlab.enabled,
        apiBaseUrl: config.integrations.gitlab.apiBaseUrl,
      },
      notion: {
        enabled: config.integrations.notion.enabled,
        databaseId: config.integrations.notion.databaseId,
        pollIntervalMs: String(config.integrations.notion.pollIntervalMs),
        initialCursor: config.integrations.notion.initialCursor,
        cursorPath: config.integrations.notion.cursorPath,
      },
    },
    data: {
      hostStatePath: config.data.hostStatePath,
      memoryPath: config.data.memoryPath,
      skillsPath: config.data.skillsPath,
      memoryLimit: String(config.data.memoryLimit),
      maxMemories: String(config.data.maxMemories),
    },
  };
}

function createJsonDraft(config: AppConfig): JsonDraft {
  return {
    mcpServers: JSON.stringify(config.data.mcpServers ?? [], null, 2),
    routerRules: JSON.stringify(config.router.rules ?? [], null, 2),
  };
}

function readList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function readNumber(value: string, fallback: number): number {
  const text = value.trim();
  if (!text) return fallback;
  const number = Number(text);
  return Number.isFinite(number) ? number : fallback;
}

function readNullableNumber(value: string): number | null {
  const text = value.trim();
  if (!text) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function parseJsonArray(text: string, label: string): unknown[] {
  const value = text.trim();
  if (!value) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} 不是有效 JSON：${errorMessage(error, "未知错误")}`, { cause: error });
  }
  if (!Array.isArray(parsed)) throw new Error(`${label} 必须是 JSON 数组`);
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function setSecretPath(target: Record<string, unknown>, path: SecretPath, value: string | null) {
  const segments = path.split(".");
  let current = target;
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const existing = current[segment];
    const next = isRecord(existing) ? existing : {};
    current[segment] = next;
    current = next;
  }
  current[segments.at(-1)!] = value;
}

function buildPayload(
  draft: SettingsDraft,
  baseConfig: AppConfig | null,
  json: JsonDraft,
  secretValues: Record<SecretPath, string>,
  touchedSecrets: ReadonlySet<SecretPath>
): Record<string, unknown> {
  const baseModel = baseConfig?.model;
  const baseRouter = baseConfig?.router;
  const baseData = baseConfig?.data;
  const workers = draft.workers.map((worker) => ({
    id: worker.id.trim(),
    description: worker.description.trim(),
    capabilities: readList(worker.capabilities),
    model: worker.model.trim(),
    reasoningEffort: worker.reasoningEffort,
    outputFormat: worker.outputFormat || "text",
    systemPrompt: worker.systemPrompt,
    tools: {
      allow: readList(worker.toolsAllow),
      deny: readList(worker.toolsDeny),
    },
    memory: {
      read: worker.memoryRead,
      write: worker.memoryWrite,
    },
    generation: {
      temperature: readNullableNumber(worker.temperature),
      topP: readNullableNumber(worker.topP),
      maxTokens: readNullableNumber(worker.maxTokens),
    },
  }));
  const workerIds = workers.map((worker) => worker.id);
  const defaultWorkerId = workerIds.includes(draft.router.defaultWorkerId)
    ? draft.router.defaultWorkerId
    : (workerIds[0] ?? "");

  const payload: Record<string, unknown> = {
    version: draft.version,
    model: {
      format: draft.model.format,
      model: draft.model.model,
      baseUrl: draft.model.baseUrl,
      routerModel: draft.model.routerModel,
      defaultTemperature: readNumber(
        draft.model.defaultTemperature,
        baseModel?.defaultTemperature ?? 0.7
      ),
      defaultTopP: readNumber(draft.model.defaultTopP, baseModel?.defaultTopP ?? 1),
    },
    router: {
      defaultWorkerId,
      defaultMaxAttempts: readNumber(
        draft.router.defaultMaxAttempts,
        baseRouter?.defaultMaxAttempts ?? 2
      ),
      retryDelayMs: readNumber(draft.router.retryDelayMs, baseRouter?.retryDelayMs ?? 1000),
      plannerTimeoutMs: readNumber(
        draft.router.plannerTimeoutMs,
        baseRouter?.plannerTimeoutMs ?? 15000
      ),
      batchIntervalMs: readNumber(draft.router.batchIntervalMs, baseRouter?.batchIntervalMs ?? 300),
      maxBatchSize: readNumber(draft.router.maxBatchSize, baseRouter?.maxBatchSize ?? 20),
      maxConcurrentTasks: readNumber(
        draft.router.maxConcurrentTasks,
        baseRouter?.maxConcurrentTasks ?? 4
      ),
      stopTimeoutMs: readNumber(draft.router.stopTimeoutMs, baseRouter?.stopTimeoutMs ?? 5000),
      outboxRetryMs: readNumber(draft.router.outboxRetryMs, baseRouter?.outboxRetryMs ?? 2000),
      notifyProgress: draft.router.notifyProgress,
      useLlmForWorkerEvents: draft.router.useLlmForWorkerEvents,
      rules: parseJsonArray(json.routerRules, "Router 规则"),
    },
    workers,
    integrations: {
      github: {
        enabled: draft.integrations.github.enabled,
        apiBaseUrl: draft.integrations.github.apiBaseUrl,
      },
      gitlab: {
        enabled: draft.integrations.gitlab.enabled,
        apiBaseUrl: draft.integrations.gitlab.apiBaseUrl,
      },
      notion: {
        enabled: draft.integrations.notion.enabled,
        databaseId: draft.integrations.notion.databaseId,
        pollIntervalMs: readNumber(
          draft.integrations.notion.pollIntervalMs,
          baseConfig?.integrations.notion.pollIntervalMs ?? 30000
        ),
        initialCursor: draft.integrations.notion.initialCursor,
        cursorPath: draft.integrations.notion.cursorPath,
      },
    },
    data: {
      hostStatePath: draft.data.hostStatePath,
      memoryPath: draft.data.memoryPath,
      skillsPath: draft.data.skillsPath,
      memoryLimit: readNumber(draft.data.memoryLimit, baseData?.memoryLimit ?? 5),
      maxMemories: readNumber(draft.data.maxMemories, baseData?.maxMemories ?? 500),
      mcpServers: parseJsonArray(json.mcpServers, "MCP 服务器配置"),
    },
  };

  for (const path of touchedSecrets) {
    const value = secretValues[path].trim();
    setSecretPath(payload, path, value === "" ? null : value);
  }
  return payload;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function validationFromFailure(error: unknown): ValidationResult | null {
  if (!(error instanceof ApiFailure)) return null;
  const payload: unknown = error.payload;
  if (!isRecord(payload) || !Array.isArray(payload.errors)) return null;
  return {
    errors: stringArray(payload.errors),
    warnings: stringArray(payload.warnings),
    issues: [],
  };
}

function apiFormat(value: string): ModelDraft["format"] {
  return value === "anthropic" || value === "gemini" ? value : "openai";
}

function reasoningEffort(value: string): WorkerDraft["reasoningEffort"] {
  return value === "low" || value === "medium" || value === "high" ? value : "";
}

function outputFormat(value: string): WorkerDraft["outputFormat"] {
  return value === "json" ? "json" : "text";
}

function defaultWorkerFor(workers: readonly WorkerDraft[], current: string): string {
  const ids = workers.map((worker) => worker.id.trim()).filter(Boolean);
  return ids.includes(current) ? current : (ids[0] ?? "");
}

function Alert({ type, children }: { type: AlertType; children: ReactNode }) {
  return (
    <div className={`alert is-${type}`}>
      <Icon name={type === "info" ? "check" : "alert"} />
      <div>{children}</div>
    </div>
  );
}

function AlertList({ type, title, items }: { type: AlertType; title: string; items: string[] }) {
  return (
    <Alert type={type}>
      {title}
      <ul>
        {items.map((item, index) => (
          <li key={`${index}:${item}`}>{item}</li>
        ))}
      </ul>
    </Alert>
  );
}

export function SettingsView({
  app,
  config,
  secretStatus,
  visible,
  onApplied,
  onReloaded,
}: SettingsViewProps) {
  const toast = useToast();
  const [draft, setDraft] = useState<SettingsDraft | null>(() =>
    config ? createDraft(config) : null
  );
  const [json, setJson] = useState<JsonDraft>(() =>
    config
      ? createJsonDraft(config)
      : {
          mcpServers: "[]",
          routerRules: "[]",
        }
  );
  const [secretValues, setSecretValues] = useState<Record<SecretPath, string>>(emptySecretValues);
  const [touchedSecrets, setTouchedSecrets] = useState<ReadonlySet<SecretPath>>(() => new Set());
  const [clearedSecrets, setClearedSecrets] = useState<ReadonlySet<SecretPath>>(() => new Set());
  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  const [externalUpdate, setExternalUpdate] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [validating, setValidating] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [modelTesting, setModelTesting] = useState(false);
  const [modelTestResult, setModelTestResult] = useState("尚未测试。");
  const [integrationTesting, setIntegrationTesting] = useState<Record<IntegrationKind, boolean>>({
    github: false,
    gitlab: false,
    notion: false,
  });
  const [integrationResults, setIntegrationResults] = useState<Record<IntegrationKind, string>>({
    github: "尚未测试。",
    gitlab: "尚未测试。",
    notion: "尚未测试。",
  });

  function markDirty(next: boolean) {
    dirtyRef.current = next;
    setDirty(next);
  }

  function resetSecrets() {
    setSecretValues(emptySecretValues());
    setTouchedSecrets(new Set());
    setClearedSecrets(new Set());
  }

  function resetTests() {
    setModelTestResult("尚未测试。");
    setIntegrationResults({ github: "尚未测试。", gitlab: "尚未测试。", notion: "尚未测试。" });
  }

  function syncFromConfig(next: AppConfig) {
    setDraft(createDraft(next));
    setJson(createJsonDraft(next));
    resetSecrets();
    setValidation(null);
    setExternalUpdate(false);
    resetTests();
    markDirty(false);
  }

  useEffect(() => {
    if (!config) {
      if (!dirtyRef.current) setDraft(null);
      return;
    }
    if (dirtyRef.current) {
      setExternalUpdate(true);
      return;
    }
    syncFromConfig(config);
  }, [config]);

  function updateModel(patch: Partial<ModelDraft>) {
    setDraft((current) =>
      current ? { ...current, model: { ...current.model, ...patch } } : current
    );
    markDirty(true);
  }

  function updateRouter(patch: Partial<RouterDraft>) {
    setDraft((current) =>
      current ? { ...current, router: { ...current.router, ...patch } } : current
    );
    markDirty(true);
  }

  function updateData(patch: Partial<DataDraft>) {
    setDraft((current) =>
      current ? { ...current, data: { ...current.data, ...patch } } : current
    );
    markDirty(true);
  }

  function updateIntegration<K extends IntegrationKind>(
    kind: K,
    patch: Partial<IntegrationDraft[K]>
  ) {
    setDraft((current) =>
      current
        ? {
            ...current,
            integrations: {
              ...current.integrations,
              [kind]: { ...current.integrations[kind], ...patch },
            },
          }
        : current
    );
    markDirty(true);
  }

  function updateWorker(index: number, patch: Partial<WorkerDraft>) {
    setDraft((current) => {
      if (!current) return current;
      const workers = current.workers.map((worker, workerIndex) =>
        workerIndex === index ? { ...worker, ...patch } : worker
      );
      return {
        ...current,
        workers,
        router: {
          ...current.router,
          defaultWorkerId:
            patch.id === undefined
              ? current.router.defaultWorkerId
              : defaultWorkerFor(workers, current.router.defaultWorkerId),
        },
      };
    });
    markDirty(true);
  }

  function updateSecret(path: SecretPath, value: string) {
    setSecretValues((current) => ({ ...current, [path]: value }));
    setTouchedSecrets((current) => new Set(current).add(path));
    markDirty(true);
  }

  function clearSecret(path: SecretPath) {
    setSecretValues((current) => ({ ...current, [path]: "" }));
    setTouchedSecrets((current) => new Set(current).add(path));
    setClearedSecrets((current) => new Set(current).add(path));
    markDirty(true);
  }

  function updateJson(path: keyof JsonDraft, value: string) {
    setJson((current) => ({ ...current, [path]: value }));
    markDirty(true);
  }

  function addWorker() {
    if (!draft) return;
    let index = draft.workers.length + 1;
    const existing = new Set(draft.workers.map((worker) => worker.id.trim()));
    let id = `worker-${index}`;
    while (existing.has(id)) {
      index += 1;
      id = `worker-${index}`;
    }
    const worker: WorkerDraft = {
      id,
      description: "新 Worker",
      capabilities: "chat",
      model: "",
      reasoningEffort: "medium",
      outputFormat: "text",
      systemPrompt: "",
      toolsAllow: "",
      toolsDeny: "",
      memoryRead: true,
      memoryWrite: true,
      temperature: "",
      topP: "",
      maxTokens: "",
    };
    const workers = [...draft.workers, worker];
    setDraft((current) =>
      current
        ? {
            ...current,
            workers,
            router: {
              ...current.router,
              defaultWorkerId: defaultWorkerFor(workers, current.router.defaultWorkerId),
            },
          }
        : current
    );
    markDirty(true);
    toast(`已添加 ${id}（保存后生效），记得设置默认 worker`, "info", 5000);
  }

  function removeWorker(index: number) {
    if (!draft) return;
    if (draft.workers.length <= 1) {
      toast("至少需要保留一个 worker", "error");
      return;
    }
    const removed = draft.workers[index];
    if (!removed || !window.confirm(`移除 worker「${removed.id || index + 1}」？`)) return;
    const workers = draft.workers.filter((_, workerIndex) => workerIndex !== index);
    setDraft((current) =>
      current
        ? {
            ...current,
            workers,
            router: {
              ...current.router,
              defaultWorkerId: defaultWorkerFor(workers, current.router.defaultWorkerId),
            },
          }
        : current
    );
    markDirty(true);
    toast(`已移除 ${removed.id}，保存后生效`, "info");
  }

  async function saveConfig(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (savingRef.current || !draft) return;
    let payload: Record<string, unknown>;
    try {
      payload = buildPayload(draft, config, json, secretValues, touchedSecrets);
    } catch (error) {
      toast(errorMessage(error, "配置格式错误"), "error", 6000);
      return;
    }
    if (!window.confirm("保存并应用配置会重启 Host；排队和运行中的任务会被取消。继续？")) return;
    savingRef.current = true;
    setSaving(true);
    toast("正在应用配置，Host 正在重启…", "info", 5000);
    try {
      const result = await api.saveConfig(payload);
      syncFromConfig(result.config);
      onApplied(result);
      toast("配置已应用，Host 已重启", "success", 5000);
    } catch (error) {
      const failureValidation = validationFromFailure(error);
      if (failureValidation) setValidation(failureValidation);
      toast(errorMessage(error, "保存失败"), "error", 8000);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }

  async function validateConfig() {
    if (validating || !draft) return;
    let payload: Record<string, unknown>;
    try {
      payload = buildPayload(draft, config, json, secretValues, touchedSecrets);
    } catch (error) {
      toast(errorMessage(error, "配置格式错误"), "error", 6000);
      return;
    }
    setValidating(true);
    try {
      const result = await api.validateConfig(payload);
      setValidation(result);
      if (result.errors?.length) toast(`发现 ${result.errors.length} 个错误`, "error", 5000);
      else toast("配置校验通过", "success", 3000);
    } catch (error) {
      toast(errorMessage(error, "校验失败"), "error", 6000);
    } finally {
      setValidating(false);
    }
  }

  async function testModel() {
    if (modelTesting || !draft) return;
    setModelTesting(true);
    setModelTestResult("正在连接模型…");
    const apiKey = secretValues["model.apiKey"].trim();
    const payload = {
      format: draft.model.format || config?.model.format || "openai",
      model: draft.model.model || config?.model.model || "",
      baseUrl: draft.model.baseUrl || config?.model.baseUrl || "",
      ...(apiKey ? { apiKey } : {}),
    };
    try {
      const result = await api.testModel(payload);
      if (result.ok) {
        setModelTestResult(`连接成功：${result.content ?? "OK"}`);
        toast("模型连接成功", "success");
      } else {
        setModelTestResult(`连接失败：${result.error ?? "未知错误"}`);
        toast(result.error ?? "模型连接失败", "error", 7000);
      }
    } catch (error) {
      setModelTestResult(`连接失败：${errorMessage(error, "未知错误")}`);
      toast(errorMessage(error, "模型连接失败"), "error", 7000);
    } finally {
      setModelTesting(false);
    }
  }

  async function testIntegration(kind: IntegrationKind) {
    if (integrationTesting[kind] || !draft) return;
    setIntegrationTesting((current) => ({ ...current, [kind]: true }));
    setIntegrationResults((current) => ({ ...current, [kind]: "正在验证凭据…" }));
    const token = secretValues[`integrations.${kind}.token` as SecretPath].trim();
    const payload: { token?: string; baseUrl?: string } = {};
    if (token) payload.token = token;
    if (kind === "github") {
      const baseUrl = draft.integrations.github.apiBaseUrl.trim();
      if (baseUrl) payload.baseUrl = baseUrl;
    } else if (kind === "gitlab") {
      const baseUrl = draft.integrations.gitlab.apiBaseUrl.trim();
      if (baseUrl) payload.baseUrl = baseUrl;
    }
    try {
      const result = await api.testIntegration(kind, payload);
      if (result.ok) {
        const label = result.label ?? "OK";
        setIntegrationResults((current) => ({ ...current, [kind]: `验证成功：${label}` }));
        toast(`${kind} 验证成功：${label}`, "success");
      } else {
        setIntegrationResults((current) => ({
          ...current,
          [kind]: `验证失败：${result.error ?? "未知错误"}`,
        }));
        toast(result.error ?? `${kind} 验证失败`, "error", 7000);
      }
    } catch (error) {
      setIntegrationResults((current) => ({
        ...current,
        [kind]: `验证失败：${errorMessage(error, "未知错误")}`,
      }));
      toast(errorMessage(error, "验证失败"), "error", 7000);
    } finally {
      setIntegrationTesting((current) => ({ ...current, [kind]: false }));
    }
  }

  async function reloadConfig() {
    if (reloading) return;
    if (dirtyRef.current && !window.confirm("放弃当前未保存的修改并重新加载？")) return;
    setReloading(true);
    try {
      const result = await api.config();
      syncFromConfig(result.config);
      onReloaded(result);
      toast("配置已重新加载", "success");
    } catch (error) {
      toast(errorMessage(error, "加载配置失败"), "error");
    } finally {
      setReloading(false);
    }
  }

  const reloadRef = useRef(reloadConfig);
  reloadRef.current = reloadConfig;
  const autoLoadAttempted = useRef(false);
  useEffect(() => {
    if (!visible) {
      autoLoadAttempted.current = false;
      return;
    }
    if (config === null && !autoLoadAttempted.current) {
      autoLoadAttempted.current = true;
      void reloadRef.current();
    }
  }, [visible, config]);

  async function copyWebhook(url: string) {
    try {
      if (!navigator.clipboard) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(url);
      toast("Webhook 地址已复制", "success", 2000);
    } catch {
      toast("复制失败", "error");
    }
  }

  const validationErrors = validation?.errors ?? [];
  const validationWarnings = validation?.warnings ?? [];
  const validationIssues = validation?.issues ?? [];
  const modelKeyTyped = Boolean(secretValues["model.apiKey"].trim());
  const modelKeyCleared = touchedSecrets.has("model.apiKey") && !modelKeyTyped;
  const modelConfigured =
    modelKeyTyped || Boolean(secretStatus["model.apiKey"]?.set && !modelKeyCleared);
  const workerChoices = draft
    ? draft.workers
        .map((worker) => worker.id.trim())
        .filter(Boolean)
        .map((id) => ({ value: id, label: id }))
    : [];
  const defaultWorkerId = draft
    ? defaultWorkerFor(draft.workers, draft.router.defaultWorkerId)
    : "";

  return (
    <section
      className={`view${visible ? " is-active" : ""}`}
      data-view-panel="settings"
      id="view-settings"
      hidden={!visible}
    >
      <div className="page-head">
        <div>
          <span className="eyebrow">Configuration</span>
          <h1>设置</h1>
          <p>模型、worker、渠道与数据路径全部在此配置，保存后立即重启 Host 生效。</p>
        </div>
        <div className="page-actions">
          <button
            className="button ghost"
            id="settings-reload"
            type="button"
            disabled={reloading || saving}
            onClick={() => void reloadConfig()}
          >
            <Icon name="refresh" />
            {reloading ? "加载中…" : "重新加载"}
          </button>
        </div>
      </div>

      <div className="settings-layout">
        <form id="settings-form" noValidate onSubmit={(event) => void saveConfig(event)}>
          <div id="settings-alerts" className="settings-alerts">
            {externalUpdate ? (
              <Alert type="info">
                配置已在其他页面或通过 API 更新。当前表单有未保存修改，重新加载可获取最新配置。
              </Alert>
            ) : null}
            {app?.lastError ? <Alert type="error">{app.lastError}</Alert> : null}
            {app?.issues.length ? (
              <AlertList type="warn" title="运行前还需要处理：" items={app.issues} />
            ) : null}
            {app?.configWarnings.length ? (
              <AlertList type="warn" title="配置加载警告：" items={app.configWarnings} />
            ) : null}
            {validationErrors.length ? (
              <AlertList type="error" title="校验失败：" items={validationErrors} />
            ) : null}
            {validationWarnings.length ? (
              <AlertList type="warn" title="校验警告：" items={validationWarnings} />
            ) : null}
            {validationIssues.length && !validationErrors.length ? (
              <Alert type="info">配置可保存，但对话仍需完成：{validationIssues.join("；")}</Alert>
            ) : null}
          </div>

          <div id="settings-content" className="settings-content">
            {!draft ? (
              <div className="settings-card">
                <div className="empty-state">
                  <strong>正在加载配置…</strong>
                </div>
              </div>
            ) : (
              <>
                <section className="settings-card">
                  <SectionHeader
                    icon="key"
                    title="模型服务"
                    description="所有 worker 和 router 共享 Provider。兼容 OpenAI 协议的服务填写自定义 Base URL 即可。"
                    headMeta={
                      <>
                        <span
                          className={`integration-state${modelConfigured ? " is-on" : ""}`}
                          id="model-state"
                        >
                          {modelConfigured ? "已配置" : "未配置"}
                        </span>
                        <button
                          className="test-button"
                          type="button"
                          id="test-model"
                          disabled={modelTesting}
                          onClick={() => void testModel()}
                        >
                          <Icon name="plug" />
                          {modelTesting ? "测试中…" : "测试连接"}
                        </button>
                      </>
                    }
                  />
                  <div className="settings-card-body">
                    <SelectField
                      label="API 格式"
                      path="model.format"
                      value={draft.model.format}
                      choices={[
                        { value: "openai", label: "OpenAI 兼容" },
                        { value: "anthropic", label: "Anthropic（尚未实现）" },
                        { value: "gemini", label: "Gemini（尚未实现）" },
                      ]}
                      onChange={(value) => updateModel({ format: apiFormat(value) })}
                    />
                    <Field
                      label="模型名称"
                      path="model.model"
                      value={draft.model.model}
                      placeholder="例如 deepseek-chat / gpt-4o-mini"
                      onChange={(value) => updateModel({ model: value })}
                    />
                    <SecretField
                      label="API Key"
                      path="model.apiKey"
                      value={secretValues["model.apiKey"]}
                      status={secretStatus["model.apiKey"]}
                      cleared={clearedSecrets.has("model.apiKey")}
                      hint="只保存在本机配置文件，返回页面时自动脱敏。"
                      onChange={(value) => updateSecret("model.apiKey", value)}
                      onClear={() => clearSecret("model.apiKey")}
                    />
                    <Field
                      label="Base URL"
                      path="model.baseUrl"
                      value={draft.model.baseUrl}
                      placeholder="https://api.openai.com/v1"
                      hint="OpenAI 兼容接口根路径，例如 https://api.deepseek.com/v1。"
                      onChange={(value) => updateModel({ baseUrl: value })}
                    />
                    <Field
                      label="Router 模型"
                      path="model.routerModel"
                      value={draft.model.routerModel}
                      placeholder="留空则复用模型名称"
                      onChange={(value) => updateModel({ routerModel: value })}
                    />
                    <Field
                      label="默认 temperature"
                      path="model.defaultTemperature"
                      value={draft.model.defaultTemperature}
                      type="number"
                      min={0}
                      max={2}
                      step={0.1}
                      onChange={(value) => updateModel({ defaultTemperature: value })}
                    />
                    <Field
                      label="默认 top_p"
                      path="model.defaultTopP"
                      value={draft.model.defaultTopP}
                      type="number"
                      min={0}
                      max={2}
                      step={0.05}
                      onChange={(value) => updateModel({ defaultTopP: value })}
                    />
                    <div className="field full">
                      <span className="hint" id="model-test-result" aria-live="polite">
                        {modelTestResult}
                      </span>
                    </div>
                  </div>
                </section>

                <section className="settings-card">
                  <SectionHeader
                    icon="monitor"
                    title="Host 与 Router"
                    description="批处理、并发、重试与 LLM 决策参数。保存后重启 Host。"
                  />
                  <div className="settings-card-body">
                    <SelectField
                      label="默认 worker"
                      path="router.defaultWorkerId"
                      value={defaultWorkerId}
                      choices={workerChoices}
                      hint="router 无法决策或未命中规则时使用。"
                      onChange={(value) => updateRouter({ defaultWorkerId: value })}
                    />
                    <Field
                      label="默认最大尝试次数"
                      path="router.defaultMaxAttempts"
                      value={draft.router.defaultMaxAttempts}
                      type="number"
                      min={1}
                      max={10}
                      onChange={(value) => updateRouter({ defaultMaxAttempts: value })}
                    />
                    <Field
                      label="重试基础延迟 ms"
                      path="router.retryDelayMs"
                      value={draft.router.retryDelayMs}
                      type="number"
                      min={0}
                      max={60000}
                      onChange={(value) => updateRouter({ retryDelayMs: value })}
                    />
                    <Field
                      label="Router LLM 超时 ms"
                      path="router.plannerTimeoutMs"
                      value={draft.router.plannerTimeoutMs}
                      type="number"
                      min={1000}
                      max={120000}
                      onChange={(value) => updateRouter({ plannerTimeoutMs: value })}
                    />
                    <Field
                      label="输入批处理窗口 ms"
                      path="router.batchIntervalMs"
                      value={draft.router.batchIntervalMs}
                      type="number"
                      min={10}
                      max={10000}
                      onChange={(value) => updateRouter({ batchIntervalMs: value })}
                    />
                    <Field
                      label="最大批量条数"
                      path="router.maxBatchSize"
                      value={draft.router.maxBatchSize}
                      type="number"
                      min={1}
                      max={500}
                      onChange={(value) => updateRouter({ maxBatchSize: value })}
                    />
                    <Field
                      label="最大并发任务"
                      path="router.maxConcurrentTasks"
                      value={draft.router.maxConcurrentTasks}
                      type="number"
                      min={1}
                      max={64}
                      onChange={(value) => updateRouter({ maxConcurrentTasks: value })}
                    />
                    <Field
                      label="停止超时 ms"
                      path="router.stopTimeoutMs"
                      value={draft.router.stopTimeoutMs}
                      type="number"
                      min={0}
                      max={120000}
                      onChange={(value) => updateRouter({ stopTimeoutMs: value })}
                    />
                    <Field
                      label="Outbox 重试间隔 ms"
                      path="router.outboxRetryMs"
                      value={draft.router.outboxRetryMs}
                      type="number"
                      min={100}
                      max={60000}
                      onChange={(value) => updateRouter({ outboxRetryMs: value })}
                    />
                    <CheckField
                      label="进度通知"
                      path="router.notifyProgress"
                      checked={draft.router.notifyProgress}
                      hint="把 worker 进度作为 notify 回复发送到渠道"
                      onChange={(checked) => updateRouter({ notifyProgress: checked })}
                    />
                    <CheckField
                      label="LLM 分析 worker 事件"
                      path="router.useLlmForWorkerEvents"
                      checked={draft.router.useLlmForWorkerEvents}
                      hint="开启后终态与重试交由 LLM 决策，成本更高"
                      onChange={(checked) => updateRouter({ useLlmForWorkerEvents: checked })}
                    />
                  </div>
                </section>

                <section className="settings-card">
                  <SectionHeader
                    icon="worker"
                    title="Workers"
                    description="每个 worker 独立执行任务，可配置模型、工具白/黑名单与记忆权限。权限在模型 schema 和实际执行两层强制。"
                    headMeta={
                      <span className="integration-state is-on">{draft.workers.length} 个</span>
                    }
                  />
                  <div className="worker-list" id="worker-list">
                    {draft.workers.map((worker, index) => (
                      <div className="worker-card" data-worker-card data-index={index} key={index}>
                        <div className="worker-card-head">
                          <span className="section-icon">
                            <Icon name="worker" />
                          </span>
                          <strong>Worker {index + 1}</strong>
                          <small>{worker.id || "未命名"}</small>
                          <div className="spacer" />
                          <button
                            className="row-action"
                            type="button"
                            data-remove-worker={index}
                            title="移除 worker"
                            onClick={() => removeWorker(index)}
                          >
                            <Icon name="trash" />
                          </button>
                        </div>
                        <div className="worker-card-body">
                          <div className="field">
                            <label>ID</label>
                            <input
                              className="input"
                              data-worker-field="id"
                              value={worker.id}
                              placeholder="general"
                              onChange={(event) => updateWorker(index, { id: event.target.value })}
                            />
                          </div>
                          <div className="field">
                            <label>描述</label>
                            <input
                              className="input"
                              data-worker-field="description"
                              value={worker.description}
                              placeholder="通用任务执行 Agent"
                              onChange={(event) =>
                                updateWorker(index, { description: event.target.value })
                              }
                            />
                          </div>
                          <div className="field">
                            <label>模型</label>
                            <input
                              className="input"
                              data-worker-field="model"
                              value={worker.model}
                              placeholder="留空使用全局模型"
                              onChange={(event) =>
                                updateWorker(index, { model: event.target.value })
                              }
                            />
                          </div>
                          <div className="field">
                            <label>Capabilities</label>
                            <input
                              className="input"
                              data-worker-field="capabilities"
                              data-value-type="list"
                              value={worker.capabilities}
                              placeholder="chat, code, tools"
                              onChange={(event) =>
                                updateWorker(index, { capabilities: event.target.value })
                              }
                            />
                          </div>
                          <div className="field">
                            <label>推理强度</label>
                            <select
                              className="select"
                              data-worker-field="reasoningEffort"
                              value={worker.reasoningEffort}
                              onChange={(event) =>
                                updateWorker(index, {
                                  reasoningEffort: reasoningEffort(event.target.value),
                                })
                              }
                            >
                              <option value="">不指定</option>
                              <option value="low">low</option>
                              <option value="medium">medium</option>
                              <option value="high">high</option>
                            </select>
                          </div>
                          <div className="field">
                            <label>输出格式</label>
                            <select
                              className="select"
                              data-worker-field="outputFormat"
                              value={worker.outputFormat}
                              onChange={(event) =>
                                updateWorker(index, {
                                  outputFormat: outputFormat(event.target.value),
                                })
                              }
                            >
                              <option value="text">text</option>
                              <option value="json">json</option>
                            </select>
                          </div>
                          <div className="field">
                            <label>Temperature</label>
                            <input
                              className="input"
                              type="number"
                              min={0}
                              max={2}
                              step={0.1}
                              data-worker-field="temperature"
                              value={worker.temperature}
                              placeholder="继承默认"
                              onChange={(event) =>
                                updateWorker(index, { temperature: event.target.value })
                              }
                            />
                          </div>
                          <div className="field">
                            <label>Top P</label>
                            <input
                              className="input"
                              type="number"
                              min={0}
                              max={2}
                              step={0.05}
                              data-worker-field="topP"
                              value={worker.topP}
                              placeholder="继承默认"
                              onChange={(event) =>
                                updateWorker(index, { topP: event.target.value })
                              }
                            />
                          </div>
                          <div className="field">
                            <label>Max tokens</label>
                            <input
                              className="input"
                              type="number"
                              min={1}
                              max={32768}
                              step={1}
                              data-worker-field="maxTokens"
                              value={worker.maxTokens}
                              placeholder="留空使用模型默认"
                              onChange={(event) =>
                                updateWorker(index, { maxTokens: event.target.value })
                              }
                            />
                          </div>
                          <div className="field">
                            <label>Tools allow</label>
                            <input
                              className="input"
                              data-worker-field="toolsAllow"
                              data-value-type="list"
                              value={worker.toolsAllow}
                              placeholder="留空表示全部允许"
                              onChange={(event) =>
                                updateWorker(index, { toolsAllow: event.target.value })
                              }
                            />
                          </div>
                          <div className="field">
                            <label>Tools deny</label>
                            <input
                              className="input"
                              data-worker-field="toolsDeny"
                              data-value-type="list"
                              value={worker.toolsDeny}
                              placeholder="bash, ..."
                              onChange={(event) =>
                                updateWorker(index, { toolsDeny: event.target.value })
                              }
                            />
                          </div>
                          <div className="field">
                            <label>记忆权限</label>
                            <div className="input-row">
                              <label className="check">
                                <input
                                  type="checkbox"
                                  data-worker-field="memoryRead"
                                  checked={worker.memoryRead}
                                  onChange={(event) =>
                                    updateWorker(index, { memoryRead: event.target.checked })
                                  }
                                />
                                读
                              </label>
                              <label className="check">
                                <input
                                  type="checkbox"
                                  data-worker-field="memoryWrite"
                                  checked={worker.memoryWrite}
                                  onChange={(event) =>
                                    updateWorker(index, { memoryWrite: event.target.checked })
                                  }
                                />
                                写
                              </label>
                            </div>
                          </div>
                          <div className="field full">
                            <label>System Prompt</label>
                            <textarea
                              className="textarea"
                              data-worker-field="systemPrompt"
                              placeholder="留空使用内置系统提示词"
                              value={worker.systemPrompt}
                              onChange={(event) =>
                                updateWorker(index, { systemPrompt: event.target.value })
                              }
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="worker-footer">
                    <button
                      className="add-worker"
                      type="button"
                      id="add-worker"
                      onClick={addWorker}
                    >
                      <Icon name="plus" />
                      添加 worker
                    </button>
                  </div>
                </section>

                <section className="settings-card integration-card" data-integration-card="github">
                  <SectionHeader
                    icon="plug"
                    title="GitHub"
                    description="issue / pull request webhook 进入 host；回复写入对应 issue 评论。"
                    headMeta={
                      <>
                        <span
                          className={`integration-state${draft.integrations.github.enabled ? " is-on" : ""}`}
                          id="github-state"
                        >
                          {draft.integrations.github.enabled ? "已启用" : "未启用"}
                        </span>
                        <button
                          className="test-button"
                          type="button"
                          data-test-integration="github"
                          disabled={integrationTesting.github}
                          onClick={() => void testIntegration("github")}
                        >
                          <Icon name="plug" />
                          {integrationTesting.github ? "验证中…" : "验证 Token"}
                        </button>
                      </>
                    }
                  />
                  <div className="settings-card-body">
                    <CheckField
                      label="启用 GitHub 渠道"
                      path="integrations.github.enabled"
                      checked={draft.integrations.github.enabled}
                      hint="需要同时填写 Token 与 Webhook Secret"
                      onChange={(checked) => updateIntegration("github", { enabled: checked })}
                    />
                    <Field
                      label="API Base URL"
                      path="integrations.github.apiBaseUrl"
                      value={draft.integrations.github.apiBaseUrl}
                      placeholder="https://api.github.com"
                      onChange={(value) => updateIntegration("github", { apiBaseUrl: value })}
                    />
                    <SecretField
                      label="Personal Access Token"
                      path="integrations.github.token"
                      value={secretValues["integrations.github.token"]}
                      status={secretStatus["integrations.github.token"]}
                      cleared={clearedSecrets.has("integrations.github.token")}
                      onChange={(value) => updateSecret("integrations.github.token", value)}
                      onClear={() => clearSecret("integrations.github.token")}
                    />
                    <SecretField
                      label="Webhook Secret"
                      path="integrations.github.webhookSecret"
                      value={secretValues["integrations.github.webhookSecret"]}
                      status={secretStatus["integrations.github.webhookSecret"]}
                      cleared={clearedSecrets.has("integrations.github.webhookSecret")}
                      hint="用于校验 x-hub-signature-256。"
                      onChange={(value) => updateSecret("integrations.github.webhookSecret", value)}
                      onClear={() => clearSecret("integrations.github.webhookSecret")}
                    />
                    <WebhookBox path="/webhooks/github" label="Webhook URL" onCopy={copyWebhook} />
                    <div className="field full">
                      <span className="hint" id="github-test-result" aria-live="polite">
                        {integrationResults.github}
                      </span>
                    </div>
                  </div>
                </section>

                <section className="settings-card integration-card" data-integration-card="gitlab">
                  <SectionHeader
                    icon="plug"
                    title="GitLab"
                    description="issue / merge request webhook 进入 host；回复写入对应 note。"
                    headMeta={
                      <>
                        <span
                          className={`integration-state${draft.integrations.gitlab.enabled ? " is-on" : ""}`}
                          id="gitlab-state"
                        >
                          {draft.integrations.gitlab.enabled ? "已启用" : "未启用"}
                        </span>
                        <button
                          className="test-button"
                          type="button"
                          data-test-integration="gitlab"
                          disabled={integrationTesting.gitlab}
                          onClick={() => void testIntegration("gitlab")}
                        >
                          <Icon name="plug" />
                          {integrationTesting.gitlab ? "验证中…" : "验证 Token"}
                        </button>
                      </>
                    }
                  />
                  <div className="settings-card-body">
                    <CheckField
                      label="启用 GitLab 渠道"
                      path="integrations.gitlab.enabled"
                      checked={draft.integrations.gitlab.enabled}
                      hint="需要同时填写 Token 与 Webhook Token"
                      onChange={(checked) => updateIntegration("gitlab", { enabled: checked })}
                    />
                    <Field
                      label="API Base URL"
                      path="integrations.gitlab.apiBaseUrl"
                      value={draft.integrations.gitlab.apiBaseUrl}
                      placeholder="https://gitlab.com/api/v4"
                      onChange={(value) => updateIntegration("gitlab", { apiBaseUrl: value })}
                    />
                    <SecretField
                      label="Private Token"
                      path="integrations.gitlab.token"
                      value={secretValues["integrations.gitlab.token"]}
                      status={secretStatus["integrations.gitlab.token"]}
                      cleared={clearedSecrets.has("integrations.gitlab.token")}
                      onChange={(value) => updateSecret("integrations.gitlab.token", value)}
                      onClear={() => clearSecret("integrations.gitlab.token")}
                    />
                    <SecretField
                      label="Webhook Token"
                      path="integrations.gitlab.webhookToken"
                      value={secretValues["integrations.gitlab.webhookToken"]}
                      status={secretStatus["integrations.gitlab.webhookToken"]}
                      cleared={clearedSecrets.has("integrations.gitlab.webhookToken")}
                      hint="用于校验 x-gitlab-token。"
                      onChange={(value) => updateSecret("integrations.gitlab.webhookToken", value)}
                      onClear={() => clearSecret("integrations.gitlab.webhookToken")}
                    />
                    <WebhookBox path="/webhooks/gitlab" label="Webhook URL" onCopy={copyWebhook} />
                    <div className="field full">
                      <span className="hint" id="gitlab-test-result" aria-live="polite">
                        {integrationResults.gitlab}
                      </span>
                    </div>
                  </div>
                </section>

                <section className="settings-card integration-card" data-integration-card="notion">
                  <SectionHeader
                    icon="plug"
                    title="Notion"
                    description="轮询数据库页面更新，并把回复写回页面评论。游标持久化到本地文件。"
                    headMeta={
                      <>
                        <span
                          className={`integration-state${draft.integrations.notion.enabled ? " is-on" : ""}`}
                          id="notion-state"
                        >
                          {draft.integrations.notion.enabled ? "已启用" : "未启用"}
                        </span>
                        <button
                          className="test-button"
                          type="button"
                          data-test-integration="notion"
                          disabled={integrationTesting.notion}
                          onClick={() => void testIntegration("notion")}
                        >
                          <Icon name="plug" />
                          {integrationTesting.notion ? "验证中…" : "验证 Token"}
                        </button>
                      </>
                    }
                  />
                  <div className="settings-card-body">
                    <CheckField
                      label="启用 Notion 渠道"
                      path="integrations.notion.enabled"
                      checked={draft.integrations.notion.enabled}
                      hint="需要 Token 与 Database ID"
                      onChange={(checked) => updateIntegration("notion", { enabled: checked })}
                    />
                    <Field
                      label="Database ID"
                      path="integrations.notion.databaseId"
                      value={draft.integrations.notion.databaseId}
                      placeholder="32 位 database id"
                      onChange={(value) => updateIntegration("notion", { databaseId: value })}
                    />
                    <SecretField
                      label="Integration Token"
                      path="integrations.notion.token"
                      value={secretValues["integrations.notion.token"]}
                      status={secretStatus["integrations.notion.token"]}
                      cleared={clearedSecrets.has("integrations.notion.token")}
                      onChange={(value) => updateSecret("integrations.notion.token", value)}
                      onClear={() => clearSecret("integrations.notion.token")}
                    />
                    <Field
                      label="轮询间隔 ms"
                      path="integrations.notion.pollIntervalMs"
                      value={draft.integrations.notion.pollIntervalMs}
                      type="number"
                      min={5000}
                      max={3600000}
                      onChange={(value) => updateIntegration("notion", { pollIntervalMs: value })}
                    />
                    <Field
                      label="初始游标"
                      path="integrations.notion.initialCursor"
                      value={draft.integrations.notion.initialCursor}
                      placeholder="可选，ISO 时间"
                      hint="数据库已有游标文件时以文件为准；留空表示首次启动当前时间。"
                      onChange={(value) => updateIntegration("notion", { initialCursor: value })}
                    />
                    <Field
                      label="游标文件"
                      path="integrations.notion.cursorPath"
                      value={draft.integrations.notion.cursorPath}
                      placeholder="data/notion-cursor"
                      hint="相对路径按仓库根目录解析。"
                      onChange={(value) => updateIntegration("notion", { cursorPath: value })}
                    />
                    <div className="field full">
                      <span className="hint" id="notion-test-result" aria-live="polite">
                        {integrationResults.notion}
                      </span>
                    </div>
                  </div>
                </section>

                <section className="settings-card">
                  <SectionHeader
                    icon="settings"
                    title="数据与高级配置"
                    description="数据路径相对仓库根目录解析。MCP 与路由规则使用 JSON，保存前会校验。"
                  />
                  <div className="settings-card-body">
                    <Field
                      label="Host 状态文件"
                      path="data.hostStatePath"
                      value={draft.data.hostStatePath}
                      hint="任务、inbox、outbox 的原子持久化文件。"
                      onChange={(value) => updateData({ hostStatePath: value })}
                    />
                    <Field
                      label="长期记忆文件"
                      path="data.memoryPath"
                      value={draft.data.memoryPath}
                      onChange={(value) => updateData({ memoryPath: value })}
                    />
                    <Field
                      label="Skills 目录"
                      path="data.skillsPath"
                      value={draft.data.skillsPath}
                      placeholder="留空不加载 skills"
                      hint="目录下每个子目录放一个 SKILL.md。"
                      onChange={(value) => updateData({ skillsPath: value })}
                    />
                    <Field
                      label="记忆检索条数"
                      path="data.memoryLimit"
                      value={draft.data.memoryLimit}
                      type="number"
                      min={1}
                      max={20}
                      onChange={(value) => updateData({ memoryLimit: value })}
                    />
                    <Field
                      label="最大记忆条数"
                      path="data.maxMemories"
                      value={draft.data.maxMemories}
                      type="number"
                      min={10}
                      max={5000}
                      onChange={(value) => updateData({ maxMemories: value })}
                    />
                    <div className="field full">
                      <label>MCP 服务器（JSON 数组）</label>
                      <textarea
                        className="textarea advanced-json"
                        id="mcp-servers-json"
                        data-value-type="json"
                        placeholder="[]"
                        value={json.mcpServers}
                        onChange={(event) => updateJson("mcpServers", event.target.value)}
                      />
                      <span className="hint">
                        每项包含 name、transport（stdio/http/https），stdio 需要 command，http 需要
                        url。支持 env 与 args。
                      </span>
                    </div>
                    <div className="field full">
                      <label>Router 规则（JSON 数组）</label>
                      <textarea
                        className="textarea advanced-json"
                        id="router-rules-json"
                        data-value-type="json"
                        placeholder="[]"
                        value={json.routerRules}
                        onChange={(event) => updateJson("routerRules", event.target.value)}
                      />
                      <span className="hint">{ROUTER_RULE_HINT}</span>
                    </div>
                    <div className="field full">
                      <label>配置文件</label>
                      <div className="webhook-url">
                        <code>{app?.configPath ?? "data/config.json"}</code>
                      </div>
                      <span className="hint">
                        包含 secret 字段，文件权限 600。不要提交到版本库。
                      </span>
                    </div>
                  </div>
                </section>
              </>
            )}
          </div>

          <div className="save-bar">
            <div className="save-note">
              <span id="settings-dirty-dot" className="dirty-dot" hidden={!dirty} />
              <span id="settings-save-note">
                {dirty
                  ? "有未保存修改。保存并应用会重启 Host 并取消执行中的任务。"
                  : "修改后需保存并应用"}
              </span>
            </div>
            <div className="save-actions">
              <button
                className="button ghost"
                type="button"
                id="settings-validate"
                disabled={!draft || validating || saving}
                onClick={() => void validateConfig()}
              >
                {validating ? "验证中…" : "验证"}
              </button>
              <button
                className="button primary"
                type="submit"
                id="settings-save"
                disabled={!draft || saving}
              >
                {saving ? (
                  <>
                    <span className="spinner sm" />
                    应用中…
                  </>
                ) : (
                  <>
                    <Icon name="check" />
                    保存并应用
                  </>
                )}
              </button>
            </div>
          </div>
        </form>
      </div>
    </section>
  );
}

export default SettingsView;
