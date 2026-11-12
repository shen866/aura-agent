import type { ServerResponse } from "node:http";

/** Server-Sent Events 集线器；所有页面共享一个只读事件流。 */
export class EventHub {
  private readonly clients = new Map<number, ServerResponse>();
  private nextClientId = 0;
  private readonly heartbeat: ReturnType<typeof setInterval>;

  constructor(heartbeatMs = 15000) {
    this.heartbeat = setInterval(() => this.ping(), heartbeatMs);
    this.heartbeat.unref?.();
  }

  get clientCount(): number {
    return this.clients.size;
  }

  add(response: ServerResponse): () => void {
    const id = ++this.nextClientId;
    this.clients.set(id, response);
    return () => this.clients.delete(id);
  }

  publish(type: string, data: unknown): void {
    let payload: string;
    try {
      payload = JSON.stringify({ type, data });
    } catch {
      return;
    }
    const frame = `event: aura\ndata: ${payload}\n\n`;
    for (const [id, response] of this.clients) {
      try {
        if (response.writableEnded || response.destroyed) {
          this.clients.delete(id);
          continue;
        }
        response.write(frame);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const response of this.clients.values()) {
      try {
        response.end();
      } catch {
        // 已断开的连接无需处理。
      }
    }
    this.clients.clear();
  }

  private ping(): void {
    for (const [id, response] of this.clients) {
      try {
        if (response.writableEnded || response.destroyed) {
          this.clients.delete(id);
          continue;
        }
        response.write(": ping\n\n");
      } catch {
        this.clients.delete(id);
      }
    }
  }
}
