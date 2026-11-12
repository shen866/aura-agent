import {
  createId,
  type InboundMessage,
  type OutboundMessage,
  type TaskRecord,
} from "@aura/protocol";
import type { Channel } from "./channel.js";

export interface OutboxOptions {
  retryMs: number;
  getChannel: (channelId: string) => Channel | undefined;
  isStarted: () => boolean;
  commit: () => Promise<void>;
  onSent: (message: OutboundMessage) => void;
  onError: (error: Error) => void;
}

/** 输出可靠性边界：持久化 outbox、串行 drain、渠道故障隔离和重试。 */
export class Outbox {
  private messages: OutboundMessage[] = [];
  private delivery: Promise<void> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly options: OutboxOptions) {}

  restore(messages: OutboundMessage[]): void {
    this.messages = structuredClone(messages);
  }

  snapshot(): OutboundMessage[] {
    return structuredClone(this.messages);
  }

  queueTask(task: TaskRecord, content: string, kind: "reply" | "notify"): void {
    this.messages.push({
      ...task.origin,
      id: kind === "reply" ? `reply:${task.id}:${task.runId}` : createId("notify"),
      content,
      taskId: task.id,
      ...(task.messageIds.at(-1) !== undefined ? { inReplyTo: task.messageIds.at(-1)! } : {}),
      sentAt: new Date().toISOString(),
    });
  }

  queueMessage(
    source: InboundMessage,
    content: string,
    options: { inReplyTo?: string; idempotencyKey: string }
  ): void {
    this.messages.push({
      channel: source.channel,
      conversationId: source.conversationId,
      ...(source.recipientId !== undefined ? { recipientId: source.recipientId } : {}),
      ...(source.metadata !== undefined ? { metadata: source.metadata } : {}),
      id: options.idempotencyKey,
      content,
      ...(options.inReplyTo !== undefined ? { inReplyTo: options.inReplyTo } : {}),
      sentAt: new Date().toISOString(),
    });
  }

  flush(): Promise<void> {
    // 新调用接到当前 drain 后面，投递期间进入的消息也有后续 drain。
    const previous = this.delivery ?? Promise.resolve();
    const delivery = previous.then(
      () => this.deliver(),
      () => this.deliver()
    );
    this.delivery = delivery;
    const cleanup = () => {
      if (this.delivery === delivery) this.delivery = undefined;
    };
    void delivery.then(cleanup, cleanup);
    return delivery;
  }

  stop(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }

  private async deliver(): Promise<void> {
    const blockedChannels = new Set<string>();
    for (const message of [...this.messages]) {
      if (blockedChannels.has(message.channel)) continue;
      const channel = this.options.getChannel(message.channel);
      if (!channel) continue;
      const index = this.messages.findIndex((pending) => pending.id === message.id);
      try {
        await channel.send(structuredClone(message));
        this.messages = this.messages.filter((pending) => pending.id !== message.id);
        try {
          await this.options.commit();
        } catch (error) {
          // 发送成功不代表投递已提交；恢复消息并尽快把恢复后的完整快照写回。
          if (!this.messages.some((pending) => pending.id === message.id)) {
            this.messages.splice(Math.max(0, index), 0, message);
          }
          try {
            await this.options.commit();
          } catch {
            // 内存仍保留消息，后续 drain 会继续尝试提交和投递。
          }
          throw error;
        }
        this.options.onSent(structuredClone(message));
      } catch (error) {
        this.options.onError(
          new Error(
            `渠道 ${message.channel} 投递失败：${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          )
        );
        if (!this.retryTimer && this.options.isStarted()) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            void this.flush();
          }, this.options.retryMs);
          this.retryTimer.unref?.();
        }
        // 保持故障渠道内部顺序，但不能阻塞其他健康渠道。
        blockedChannels.add(message.channel);
      }
    }
  }
}
