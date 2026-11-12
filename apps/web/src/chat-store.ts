import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createId } from "@aura/protocol";

export type ChatRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  createdAt: string;
  /** 该回复所属任务。 */
  taskId?: string | undefined;
  /** 渠道侧消息 ID，用于崩溃后重投的幂等去重。 */
  sourceId?: string | undefined;
}

export interface Conversation {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessage: string;
}

interface ChatState {
  conversations: Conversation[];
}

const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES = 200;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function toSummary(conversation: Conversation): ConversationSummary {
  return {
    id: conversation.id,
    title: conversation.title,
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    lastMessage: conversation.messages.at(-1)?.content.slice(0, 120) ?? "",
  };
}

function normalizeMessage(raw: unknown): ChatMessage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const entry = raw as Record<string, unknown>;
  const role = entry.role;
  if (role !== "user" && role !== "assistant" && role !== "system") return undefined;
  const message: ChatMessage = {
    id: String(entry.id ?? createId("msg")),
    role,
    content: String(entry.content ?? ""),
    createdAt: String(entry.createdAt ?? new Date().toISOString()),
  };
  if (entry.taskId !== undefined) message.taskId = String(entry.taskId);
  if (entry.sourceId !== undefined) message.sourceId = String(entry.sourceId);
  return message;
}

function normalizeConversation(raw: unknown): Conversation | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const record = raw as Record<string, unknown>;
  const messages = Array.isArray(record.messages)
    ? record.messages
        .map(normalizeMessage)
        .filter((message): message is ChatMessage => message !== undefined)
    : [];
  return {
    id: String(record.id ?? createId("conv")),
    title: String(record.title ?? "新对话"),
    createdAt: String(record.createdAt ?? new Date().toISOString()),
    updatedAt: String(record.updatedAt ?? new Date().toISOString()),
    messages,
  };
}

function normalizeState(raw: unknown): ChatState {
  const source = raw !== null && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const conversations = Array.isArray(source.conversations)
    ? source.conversations
        .map(normalizeConversation)
        .filter((conversation): conversation is Conversation => conversation !== undefined)
    : [];
  return { conversations };
}

export class ChatStore {
  private state: ChatState = { conversations: [] };
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();
  private loadWarning: string | undefined;

  constructor(private readonly filePath: string) {}

  get warning(): string | undefined {
    return this.loadWarning;
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    try {
      this.state = normalizeState(JSON.parse(await readFile(this.filePath, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // 损坏的对话记录不应阻止控制台启动；保留文件并重置内存态。
        this.loadWarning = `对话记录读取失败，已使用空记录：${
          error instanceof Error ? error.message : String(error)
        }`;
        this.state = { conversations: [] };
      } else {
        this.state = { conversations: [] };
      }
    }
    this.loaded = true;
  }

  list(): ConversationSummary[] {
    return [...this.state.conversations]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .map(toSummary);
  }

  get(id: string): Conversation | undefined {
    const conversation = this.find(id);
    return conversation ? clone(conversation) : undefined;
  }

  summary(id: string): ConversationSummary | undefined {
    const conversation = this.find(id);
    if (!conversation) return undefined;
    return toSummary(conversation);
  }

  async create(title = "新对话"): Promise<Conversation> {
    await this.load();
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id: createId("conv"),
      title: title.trim() || "新对话",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.state.conversations.push(conversation);
    this.trimConversations();
    await this.persist();
    return clone(conversation);
  }

  async ensure(id: string, title = "新对话"): Promise<Conversation> {
    await this.load();
    const existing = this.find(id);
    if (existing) return clone(existing);
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id,
      title: title.trim() || "新对话",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.state.conversations.push(conversation);
    this.trimConversations();
    await this.persist();
    return clone(conversation);
  }

  async appendUser(
    id: string,
    content: string,
    messageId = createId("msg")
  ): Promise<Conversation> {
    return this.append(id, {
      id: messageId,
      role: "user",
      content,
      createdAt: new Date().toISOString(),
    });
  }

  async appendAssistant(
    id: string,
    content: string,
    options: { taskId?: string; sourceId?: string; messageId?: string } = {}
  ): Promise<Conversation> {
    await this.load();
    const conversation = this.find(id) ?? this.createInMemory(id);
    if (options.sourceId) {
      const duplicate = conversation.messages.some(
        (message) => message.sourceId === options.sourceId
      );
      if (duplicate) return clone(conversation);
    }
    conversation.messages.push({
      id: options.messageId ?? createId("msg"),
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
      ...(options.taskId !== undefined ? { taskId: options.taskId } : {}),
      ...(options.sourceId !== undefined ? { sourceId: options.sourceId } : {}),
    });
    this.touch(conversation);
    this.trimMessages(conversation);
    await this.persist();
    return clone(conversation);
  }

  async delete(id: string): Promise<boolean> {
    await this.load();
    const before = this.state.conversations.length;
    this.state.conversations = this.state.conversations.filter(
      (conversation) => conversation.id !== id
    );
    if (this.state.conversations.length === before) return false;
    await this.persist();
    return true;
  }

  private async append(
    id: string,
    message: Omit<ChatMessage, "role"> & { role: ChatRole }
  ): Promise<Conversation> {
    await this.load();
    const conversation = this.find(id) ?? this.createInMemory(id);
    conversation.messages.push(message);
    if (conversation.title === "新对话" && message.role === "user") {
      conversation.title = message.content.trim().slice(0, 40) || "新对话";
    }
    this.touch(conversation);
    this.trimMessages(conversation);
    await this.persist();
    return clone(conversation);
  }

  private createInMemory(id: string): Conversation {
    const now = new Date().toISOString();
    const conversation: Conversation = {
      id,
      title: "新对话",
      createdAt: now,
      updatedAt: now,
      messages: [],
    };
    this.state.conversations.push(conversation);
    this.trimConversations();
    return conversation;
  }

  private find(id: string): Conversation | undefined {
    return this.state.conversations.find((conversation) => conversation.id === id);
  }

  private touch(conversation: Conversation): void {
    conversation.updatedAt = new Date().toISOString();
  }

  private trimMessages(conversation: Conversation): void {
    if (conversation.messages.length > MAX_MESSAGES) {
      conversation.messages = conversation.messages.slice(-MAX_MESSAGES);
    }
  }

  private trimConversations(): void {
    if (this.state.conversations.length <= MAX_CONVERSATIONS) return;
    this.state.conversations = [...this.state.conversations]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, MAX_CONVERSATIONS);
  }

  private async persist(): Promise<void> {
    const snapshot = clone(this.state);
    const write = this.writeChain.then(() => this.write(snapshot));
    this.writeChain = write.then(
      () => undefined,
      () => undefined
    );
    await write;
  }

  private async write(state: ChatState): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.filePath);
  }
}
