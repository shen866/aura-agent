import http from "node:http";
import type { WebhookRequest, WebhookResponse } from "./github.js";

export interface WebhookChannelAdapter {
  handleWebhook(request: WebhookRequest): Promise<WebhookResponse>;
}

export interface WebhookServerOptions {
  port: number;
  host?: string | undefined;
  routes: Record<string, WebhookChannelAdapter>;
  maxBodyBytes?: number | undefined;
}

/** 可选的轻量 HTTP 入口；业务服务也可用各自框架直接调用 handleWebhook。 */
export function createWebhookServer(options: WebhookServerOptions): http.Server {
  return http.createServer((request, response) => {
    void (async () => {
      const adapter = options.routes[request.url ?? ""];
      if (!adapter || request.method !== "POST") {
        response.writeHead(404).end("not found");
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size > (options.maxBodyBytes ?? 1_048_576)) {
          response.writeHead(413).end("body too large");
          return;
        }
        chunks.push(buffer);
      }
      try {
        const result = await adapter.handleWebhook({
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response.writeHead(result.status, { "content-type": "text/plain; charset=utf-8" });
        response.end(result.body);
      } catch (error) {
        // 非 2xx 让 GitHub/GitLab 重投；inbox 外部 ID 负责去重。
        response.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
        response.end(error instanceof Error ? error.message : String(error));
      }
    })().catch(() => {
      if (!response.headersSent) response.writeHead(500);
      response.end();
    });
  });
}
