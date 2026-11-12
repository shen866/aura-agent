import { readFile, stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { ConfigValidationError, ApiError } from "./errors.js";
import type { AppManager } from "./app-manager.js";
import type { EventHub } from "./event-hub.js";

export interface WebServerOptions {
  manager: AppManager;
  hub: EventHub;
  publicRoot: string;
  host?: string | undefined;
  port: number;
}

export interface WebServerHandle {
  server: http.Server;
  port: number;
  close: () => Promise<void>;
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_WEBHOOK_BYTES = 1024 * 1024;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(payload);
}

function sendText(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    "content-type": "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

async function readRawBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new ApiError(413, "请求体过大");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const text = await readRawBody(request);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "请求体不是有效 JSON");
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function requestConfig(body: unknown): unknown {
  const record = asRecord(body);
  return record.config !== undefined ? record.config : body;
}

async function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  publicRoot: string
): Promise<void> {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (relative.includes("\0")) throw new ApiError(400, "非法路径");
  const normalized = path.normalize(relative);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    throw new ApiError(404, "Not found");
  }
  const fullPath = path.join(publicRoot, normalized);
  const root = path.resolve(publicRoot);
  const resolved = path.resolve(fullPath);
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new ApiError(404, "Not found");
  }
  let info;
  try {
    info = await stat(resolved);
  } catch {
    throw new ApiError(404, "Not found");
  }
  if (!info.isFile()) throw new ApiError(404, "Not found");
  const extension = path.extname(resolved).toLowerCase();
  const contentType = CONTENT_TYPES[extension] ?? "application/octet-stream";
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": contentType,
    "cache-control": "no-cache",
  });
  if (request.method === "HEAD") {
    response.end();
    return;
  }
  response.end(await readFile(resolved));
}

function openSse(
  request: IncomingMessage,
  response: ServerResponse,
  manager: AppManager,
  hub: EventHub
): void {
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  const initial = JSON.stringify({ type: "ready", data: { status: manager.status() } });
  response.write(`event: aura\ndata: ${initial}\n\n`);
  const remove = hub.add(response);
  request.on("close", remove);
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: WebServerOptions
): Promise<void> {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  const pathname = url.pathname;
  const method = request.method ?? "GET";
  const { manager, hub } = options;

  if (pathname === "/api/health") {
    sendJson(response, 200, { ok: true, now: new Date().toISOString() });
    return;
  }

  if (pathname === "/api/events") {
    openSse(request, response, manager, hub);
    return;
  }

  if (pathname === "/api/bootstrap" && method === "GET") {
    const status = manager.status();
    sendJson(response, 200, {
      app: status,
      config: manager.publicConfig(),
      secretStatus: manager.secretStatus(),
      conversations: manager.listConversations(),
      tasks: manager.listTasks({ limit: 50 }),
      server: { now: new Date().toISOString() },
    });
    return;
  }

  if (pathname === "/api/status" && method === "GET") {
    sendJson(response, 200, manager.status());
    return;
  }

  if (pathname === "/api/config" && method === "GET") {
    sendJson(response, 200, {
      config: manager.publicConfig(),
      secretStatus: manager.secretStatus(),
      status: manager.status(),
    });
    return;
  }

  if (pathname === "/api/config" && method === "PUT") {
    const body = await readJsonBody(request);
    const result = await manager.applyConfig(requestConfig(body));
    sendJson(response, 200, result);
    return;
  }

  if (pathname === "/api/config/validate" && method === "POST") {
    const body = await readJsonBody(request);
    sendJson(response, 200, manager.validateConfig(requestConfig(body)));
    return;
  }

  if (pathname === "/api/tasks" && method === "GET") {
    const status = url.searchParams.get("status") ?? undefined;
    const workerId = url.searchParams.get("worker") ?? undefined;
    const search = url.searchParams.get("search") ?? undefined;
    const requestedLimit = Number(url.searchParams.get("limit") ?? "100");
    const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? requestedLimit : 100;
    sendJson(response, 200, {
      tasks: manager.listTasks({ status, workerId, search, limit }),
      status: manager.status(),
    });
    return;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && method === "GET") {
    const detail = manager.taskDetail(decodeURIComponent(taskMatch[1]!));
    if (!detail) throw new ApiError(404, "任务不存在");
    sendJson(response, 200, detail);
    return;
  }

  const cancelMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/cancel$/);
  if (cancelMatch && method === "POST") {
    await manager.cancelTask(decodeURIComponent(cancelMatch[1]!));
    sendJson(response, 200, { ok: true, status: manager.status() });
    return;
  }

  if (pathname === "/api/conversations" && method === "GET") {
    sendJson(response, 200, { conversations: manager.listConversations() });
    return;
  }

  if (pathname === "/api/conversations" && method === "POST") {
    const body = await readJsonBody(request);
    const record = asRecord(body);
    const title = typeof record.title === "string" ? record.title : undefined;
    const conversation = await manager.createConversation(title);
    sendJson(response, 200, { conversation, conversations: manager.listConversations() });
    return;
  }

  const conversationMatch = pathname.match(/^\/api\/conversations\/([^/]+)$/);
  if (conversationMatch && method === "GET") {
    sendJson(response, 200, manager.getConversation(decodeURIComponent(conversationMatch[1]!)));
    return;
  }

  if (conversationMatch && method === "DELETE") {
    await manager.deleteConversation(decodeURIComponent(conversationMatch[1]!));
    sendJson(response, 200, { ok: true, conversations: manager.listConversations() });
    return;
  }

  const messageMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messageMatch && method === "POST") {
    const body = await readJsonBody(request);
    const record = asRecord(body);
    const content = typeof record.content === "string" ? record.content : "";
    const view = await manager.sendChat(decodeURIComponent(messageMatch[1]!), content);
    sendJson(response, 200, view);
    return;
  }

  if (pathname === "/api/model/test" && method === "POST") {
    const body = await readJsonBody(request);
    sendJson(response, 200, await manager.testModel(body));
    return;
  }

  const integrationMatch = pathname.match(/^\/api\/integrations\/([^/]+)\/test$/);
  if (integrationMatch && method === "POST") {
    const body = await readJsonBody(request);
    sendJson(
      response,
      200,
      await manager.testIntegration(decodeURIComponent(integrationMatch[1]!), body)
    );
    return;
  }

  const webhookMatch = pathname.match(/^\/webhooks\/(github|gitlab)$/);
  if (webhookMatch) {
    if (method !== "POST") throw new ApiError(405, "仅支持 POST");
    const route = manager.getWebhookAdapter(webhookMatch[1]!);
    if (!route?.adapter) throw new ApiError(503, "该 Webhook 渠道未启用或尚未就绪");
    const body = await readRawBody(request, MAX_WEBHOOK_BYTES);
    const result = await route.adapter.handleWebhook({ headers: request.headers, body });
    sendText(response, result.status, result.body);
    return;
  }

  if ((method === "GET" || method === "HEAD") && !pathname.startsWith("/api/")) {
    await serveStatic(request, response, pathname, options.publicRoot);
    return;
  }

  throw new ApiError(404, "Not found");
}

function handleError(
  response: ServerResponse,
  error: unknown,
  log: (message: string) => void
): void {
  if (response.headersSent) {
    try {
      response.end();
    } catch {
      // 已结束。
    }
    return;
  }
  if (error instanceof ConfigValidationError) {
    sendJson(response, 400, {
      error: error.message,
      errors: error.errors,
      warnings: error.warnings,
    });
    return;
  }
  if (error instanceof ApiError) {
    sendJson(response, error.status, {
      error: error.message,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
    return;
  }
  log(`请求失败：${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
  sendJson(response, 500, {
    error: error instanceof Error ? error.message : String(error),
  });
}

export async function startWebServer(options: WebServerOptions): Promise<WebServerHandle> {
  const log = (message: string) => console.error(`[Aura] ${message}`);
  const server = http.createServer((request, response) => {
    void handleRequest(request, response, options).catch((error) =>
      handleError(response, error, log)
    );
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = address !== null && typeof address === "object" ? address.port : options.port;
  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections?.();
      }),
  };
}
