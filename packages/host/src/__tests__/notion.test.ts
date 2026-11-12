import { describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "@aura/protocol";
import { NotionChannel, type NotionCursorStore } from "../integrations/notion.js";

function page(id: string, edited: string): Record<string, unknown> {
  return {
    id,
    last_edited_time: edited,
    last_edited_by: { id: "user" },
    properties: { Name: { type: "title", title: [{ plain_text: id }] } },
  };
}

describe("NotionChannel", () => {
  it("持久化游标、处理分页，并在重启后接收停机期间更新", async () => {
    let stored = "2020-01-01T00:00:00.000Z";
    const cursorStore: NotionCursorStore = {
      read: async () => stored,
      write: async (cursor) => {
        stored = cursor;
      },
    };
    const requests: string[] = [];
    const firstFetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requests.push(String(init?.body));
      const firstPage = requests.length === 1;
      return new Response(
        JSON.stringify(
          firstPage
            ? {
                results: [
                  page("p1", "2021-01-01T00:00:00.000Z"),
                  page("p2", "2022-01-01T00:00:00.000Z"),
                ],
                has_more: true,
                next_cursor: "next-page",
              }
            : {
                results: [page("p3", "2023-01-01T00:00:00.000Z")],
                has_more: false,
                next_cursor: null,
              }
        ),
        { status: 200 }
      );
    }) as unknown as typeof fetch;
    const firstMessages: InboundMessage[] = [];
    const first = new NotionChannel({
      token: "token",
      databaseId: "database",
      cursorStore,
      fetch: firstFetch,
      pollIntervalMs: 60_000,
    });
    await first.start(async (message) => {
      firstMessages.push(message);
    });
    await first.stop();
    expect(firstMessages.map((message) => message.metadata?.pageId)).toEqual(["p1", "p2", "p3"]);
    expect(requests[1]).toContain("next-page");
    expect(stored).toBe("2023-01-01T00:00:00.000Z");

    const secondMessages: InboundMessage[] = [];
    const second = new NotionChannel({
      token: "token",
      databaseId: "database",
      cursorStore,
      // 默认 initialCursor 是当前时间，持久化值必须覆盖它。
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              results: [page("p4", "2024-01-01T00:00:00.000Z")],
              has_more: false,
              next_cursor: null,
            }),
            { status: 200 }
          )
      ) as unknown as typeof fetch,
      pollIntervalMs: 60_000,
    });
    await second.start(async (message) => {
      secondMessages.push(message);
    });
    await second.stop();
    expect(secondMessages.map((message) => message.metadata?.pageId)).toEqual(["p4"]);
    expect(second.getCursor()).toBe("2024-01-01T00:00:00.000Z");
  });
});
