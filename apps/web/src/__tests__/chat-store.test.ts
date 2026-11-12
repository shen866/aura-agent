import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ChatStore } from "../chat-store.js";

const directories: string[] = [];

async function tempStore(): Promise<{ store: ChatStore; file: string; dir: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "aura-chat-"));
  directories.push(dir);
  const file = path.join(dir, "chat.json");
  const store = new ChatStore(file);
  await store.load();
  return { store, file, dir };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("ChatStore", () => {
  it("creates conversations, derives titles and persists messages", async () => {
    const { store, file } = await tempStore();
    const conversation = await store.create();
    const updated = await store.appendUser(conversation.id, "请帮我整理今天的任务");
    expect(updated.title).toBe("请帮我整理今天的任务");
    expect(updated.messages).toHaveLength(1);

    const withReply = await store.appendAssistant(conversation.id, "已完成", {
      taskId: "task-1",
      sourceId: "reply-1",
    });
    expect(withReply.messages).toHaveLength(2);
    expect(withReply.messages[1]!.role).toBe("assistant");
    expect(withReply.messages[1]!.taskId).toBe("task-1");

    const reloaded = new ChatStore(file);
    await reloaded.load();
    expect(reloaded.get(conversation.id)?.messages).toHaveLength(2);
    expect(reloaded.summary(conversation.id)?.lastMessage).toBe("已完成");

    const persisted = JSON.parse(await readFile(file, "utf8")) as {
      conversations: Array<{ messages: unknown[] }>;
    };
    expect(persisted.conversations[0]!.messages).toHaveLength(2);
  });

  it("deduplicates assistant replies by source id", async () => {
    const { store } = await tempStore();
    const conversation = await store.create();
    await store.appendUser(conversation.id, "hello");
    const first = await store.appendAssistant(conversation.id, "reply", { sourceId: "out-1" });
    const second = await store.appendAssistant(conversation.id, "reply", { sourceId: "out-1" });
    expect(first.messages).toHaveLength(2);
    expect(second.messages).toHaveLength(2);
  });

  it("recovers from a corrupt chat file instead of blocking startup", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "aura-chat-"));
    directories.push(dir);
    const file = path.join(dir, "chat.json");
    await writeFile(file, "{not json", "utf8");
    const store = new ChatStore(file);
    await store.load();
    expect(store.warning).toContain("读取失败");
    expect(store.list()).toEqual([]);
  });

  it("deletes conversations and ignores unknown ids", async () => {
    const { store } = await tempStore();
    const conversation = await store.create();
    expect(await store.delete(conversation.id)).toBe(true);
    expect(store.get(conversation.id)).toBeUndefined();
    expect(await store.delete("missing")).toBe(false);
  });
});
