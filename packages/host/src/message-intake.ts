import type { InboundMessage } from "@aura/protocol";
import { BatchQueue } from "./batch-queue.js";

export interface MessageIntakeOptions {
  maxWaitMs: number;
  maxBatchSize: number;
  process: (messages: InboundMessage[]) => Promise<void>;
  commit: () => Promise<void>;
  onAccepted: (message: InboundMessage) => void;
  onError: (error: Error) => void;
}

/** 输入可靠性边界：去重、inbox 持久化、ack 和输入批次。 */
export class MessageIntake {
  private readonly queue: BatchQueue<InboundMessage>;
  private readonly processedMessageKeys = new Set<string>();
  private inbox: InboundMessage[] = [];

  constructor(private readonly options: MessageIntakeOptions) {
    this.queue = new BatchQueue({
      maxWaitMs: options.maxWaitMs,
      maxBatchSize: options.maxBatchSize,
      process: options.process,
      onError: options.onError,
    });
  }

  restore(inbox: InboundMessage[], processedMessageKeys: string[]): void {
    this.inbox = structuredClone(inbox);
    this.processedMessageKeys.clear();
    for (const key of processedMessageKeys) this.processedMessageKeys.add(key);
  }

  reopen(): void {
    this.queue.reopen();
  }

  resume(): void {
    for (const message of this.inbox) this.queue.push(message);
  }

  /** 只有 inbox 持久化完成后才 resolve，渠道此时才能 ack。 */
  async ingest(message: InboundMessage): Promise<boolean> {
    const key = this.messageKey(message);
    if (
      this.processedMessageKeys.has(key) ||
      this.inbox.some((pending) => this.messageKey(pending) === key)
    ) {
      return false;
    }

    this.inbox.push(structuredClone(message));
    try {
      await this.options.commit();
    } catch (error) {
      this.inbox = this.inbox.filter((pending) => pending.id !== message.id);
      throw error;
    }

    try {
      this.queue.push(message);
    } catch (error) {
      this.inbox = this.inbox.filter((pending) => pending.id !== message.id);
      await this.options.commit();
      throw error;
    }
    this.options.onAccepted(structuredClone(message));
    return true;
  }

  complete(messages: InboundMessage[]): void {
    const ids = new Set(messages.map((message) => message.id));
    this.inbox = this.inbox.filter((message) => !ids.has(message.id));
    for (const message of messages) this.processedMessageKeys.add(this.messageKey(message));
  }

  snapshot(): InboundMessage[] {
    return structuredClone(this.inbox);
  }

  processedSnapshot(): string[] {
    return [...this.processedMessageKeys];
  }

  async flush(): Promise<void> {
    await this.queue.flush();
  }

  async close(): Promise<void> {
    await this.queue.close();
  }

  private messageKey(message: InboundMessage): string {
    return `${message.channel}:${message.externalId ?? message.id}`;
  }
}
