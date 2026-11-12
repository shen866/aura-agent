import type {
  ApiErrorPayload,
  AppStatus,
  ApplyConfigResult,
  BootstrapData,
  ConfigResult,
  Conversation,
  ConversationSummary,
  ConversationView,
  TaskDetail,
  TaskSummary,
  ValidationResult,
} from "./types";

export class ApiFailure extends Error {
  readonly status: number;
  readonly payload: ApiErrorPayload | null;

  constructor(message: string, status: number, payload: ApiErrorPayload | null) {
    super(message);
    this.name = "ApiFailure";
    this.status = status;
    this.payload = payload;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  const init: RequestInit = { method: options.method ?? "GET", headers };
  if (options.signal) init.signal = options.signal;
  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(path, init);
  } catch (error) {
    throw new ApiFailure(error instanceof Error ? error.message : "网络请求失败", 0, null);
  }
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = { error: text };
    }
  }
  const errorPayload =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? (payload as ApiErrorPayload)
      : null;
  if (!response.ok) {
    throw new ApiFailure(
      errorPayload?.error ?? `请求失败（HTTP ${response.status}）`,
      response.status,
      errorPayload
    );
  }
  return payload as T;
}

export const api = {
  bootstrap: () => request<BootstrapData>("/api/bootstrap"),
  status: () => request<AppStatus>("/api/status"),
  config: () => request<ConfigResult>("/api/config"),
  saveConfig: (config: unknown) =>
    request<ApplyConfigResult>("/api/config", { method: "PUT", body: { config } }),
  validateConfig: (config: unknown) =>
    request<ValidationResult>("/api/config/validate", { method: "POST", body: { config } }),
  tasks: (params: { status?: string; worker?: string; search?: string; limit?: number } = {}) => {
    const search = new URLSearchParams();
    if (params.status) search.set("status", params.status);
    if (params.worker) search.set("worker", params.worker);
    if (params.search) search.set("search", params.search);
    if (params.limit) search.set("limit", String(params.limit));
    const suffix = search.size > 0 ? `?${search.toString()}` : "";
    return request<{ tasks: TaskSummary[]; status: AppStatus }>(`/api/tasks${suffix}`);
  },
  task: (id: string) => request<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`),
  cancelTask: (id: string) =>
    request<{ ok: boolean; status: AppStatus }>(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
      method: "POST",
    }),
  conversations: () => request<{ conversations: ConversationSummary[] }>("/api/conversations"),
  createConversation: (title?: string) =>
    request<{ conversation: Conversation; conversations: ConversationSummary[] }>(
      "/api/conversations",
      { method: "POST", body: title ? { title } : {} }
    ),
  conversation: (id: string) =>
    request<ConversationView>(`/api/conversations/${encodeURIComponent(id)}`),
  deleteConversation: (id: string) =>
    request<{ ok: boolean; conversations: ConversationSummary[] }>(
      `/api/conversations/${encodeURIComponent(id)}`,
      { method: "DELETE" }
    ),
  sendMessage: (id: string, content: string) =>
    request<ConversationView>(`/api/conversations/${encodeURIComponent(id)}/messages`, {
      method: "POST",
      body: { content },
    }),
  testModel: (model: { format: string; model: string; baseUrl: string; apiKey?: string }) =>
    request<{ ok: boolean; content?: string; error?: string }>("/api/model/test", {
      method: "POST",
      body: model,
    }),
  testIntegration: (kind: string, payload: { token?: string; baseUrl?: string } = {}) =>
    request<{ ok: boolean; label?: string; error?: string }>(
      `/api/integrations/${encodeURIComponent(kind)}/test`,
      { method: "POST", body: payload }
    ),
};
