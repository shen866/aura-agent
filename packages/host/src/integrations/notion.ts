import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId, type InboundMessage, type OutboundMessage } from "@aura/protocol";
import type { Channel, InboundSink } from "../channel.js";

export interface NotionCursorStore {
  read(): Promise<string | undefined>;
  write(cursor: string): Promise<void>;
}

export class FileNotionCursorStore implements NotionCursorStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<string | undefined> {
    try {
      return (await readFile(this.filePath, "utf8")).trim() || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async write(cursor: string): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, cursor, "utf8");
    await rename(temporary, this.filePath);
  }
}

export interface NotionChannelOptions {
  id?: string | undefined;
  token: string;
  databaseId: string;
  pollIntervalMs?: number | undefined;
  initialCursor?: string | undefined;
  cursorStore?: NotionCursorStore | undefined;
  fetch?: typeof fetch | undefined;
  onError?: ((error: Error) => void) | undefined;
}

/** 轮询 Notion 数据库的页面更新；每条消息在 host 持久化后才推进游标。 */
export class NotionChannel implements Channel {
  readonly id: string;
  private sink?: InboundSink;
  private timer: ReturnType<typeof setInterval> | undefined;
  private cursor: string;
  private polling = false;

  constructor(private readonly options: NotionChannelOptions) {
    this.id = options.id ?? "notion";
    this.cursor = options.initialCursor ?? new Date().toISOString();
  }

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
    this.cursor = (await this.options.cursorStore?.read()) ?? this.cursor;
    await this.pollNow();
    this.timer = setInterval(() => {
      void this.pollNow().catch((error) => this.options.onError?.(error));
    }, this.options.pollIntervalMs ?? 30_000);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async pollNow(): Promise<void> {
    if (this.polling || !this.sink) return;
    this.polling = true;
    try {
      let startCursor: string | undefined;
      do {
        const response = await this.request(`/databases/${this.options.databaseId}/query`, {
          method: "POST",
          body: JSON.stringify({
            page_size: 100,
            sorts: [{ timestamp: "last_edited_time", direction: "ascending" }],
            ...(startCursor ? { start_cursor: startCursor } : {}),
          }),
        });
        const payload = (await response.json()) as {
          results?: any[];
          has_more?: boolean;
          next_cursor?: string | null;
        };
        const pages = (payload.results ?? [])
          .filter(
            (page) => new Date(page.last_edited_time).getTime() >= new Date(this.cursor).getTime()
          )
          .sort((left, right) =>
            String(left.last_edited_time).localeCompare(String(right.last_edited_time))
          );
        for (const page of pages) {
          const nextCursor = String(page.last_edited_time);
          await this.sink(this.toMessage(page));
          await this.options.cursorStore?.write(nextCursor);
          this.cursor = nextCursor;
        }
        startCursor = payload.has_more && payload.next_cursor ? payload.next_cursor : undefined;
      } while (startCursor);
    } finally {
      this.polling = false;
    }
  }

  async send(message: OutboundMessage): Promise<void> {
    const pageId = message.metadata?.pageId;
    if (typeof pageId !== "string") throw new Error("Notion 回复缺少 pageId metadata");
    // Notion 单个 rich_text 块最多 2000 字符。
    const chunks = message.content.match(/[\s\S]{1,2000}/g) ?? [];
    const response = await this.request("/comments", {
      method: "POST",
      body: JSON.stringify({
        parent: { page_id: pageId },
        rich_text: chunks.map((content) => ({ type: "text", text: { content } })),
      }),
    });
    if (!response.ok) throw new Error(`Notion API ${response.status}: ${await response.text()}`);
  }

  getCursor(): string {
    return this.cursor;
  }

  private toMessage(page: any): InboundMessage {
    const properties = Object.values(page.properties ?? {}) as any[];
    const titleProperty = properties.find((property) => property.type === "title");
    const title = (titleProperty?.title ?? [])
      .map((text: any) => String(text.plain_text ?? ""))
      .join("");
    return {
      id: createId("notion"),
      externalId: `${page.id}:${page.last_edited_time}`,
      channel: this.id,
      conversationId: page.id,
      senderId: String(page.last_edited_by?.id ?? "notion"),
      content: `[Notion 页面更新] ${title || page.id}\n${page.url ?? ""}`,
      kind: "page",
      receivedAt: new Date().toISOString(),
      metadata: {
        pageId: page.id,
        resourceId: page.id,
        sourceVersion: page.last_edited_time,
        url: page.url,
      },
    };
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const response = await (this.options.fetch ?? fetch)(`https://api.notion.com/v1${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.options.token}`,
        "notion-version": "2022-06-28",
        "content-type": "application/json",
        ...init.headers,
      },
    });
    if (!response.ok) throw new Error(`Notion API ${response.status}: ${await response.text()}`);
    return response;
  }
}
