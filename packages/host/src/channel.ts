import type { InboundMessage, OutboundMessage } from "@aura/protocol";

export type InboundSink = (message: InboundMessage) => Promise<void>;

/** 输入与输出相互独立；start 后随时可调用 sink，host 也随时可调用 send。 */
export interface Channel {
  readonly id: string;
  start(sink: InboundSink): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  stop?(): Promise<void>;
}

export class FunctionChannel implements Channel {
  readonly id: string;
  private sink?: InboundSink;
  private readonly sent: OutboundMessage[] = [];

  constructor(id = "memory") {
    this.id = id;
  }

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
  }

  async emit(message: InboundMessage): Promise<void> {
    if (!this.sink) throw new Error(`channel ${this.id} 尚未启动`);
    await this.sink(message);
  }

  async send(message: OutboundMessage): Promise<void> {
    this.sent.push(message);
  }

  get messages(): OutboundMessage[] {
    return [...this.sent];
  }
}
