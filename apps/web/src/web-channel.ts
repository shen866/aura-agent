import type { OutboundMessage } from "@aura/protocol";
import type { Channel, InboundSink } from "@aura/host";
import type { ChatStore } from "./chat-store.js";
import type { EventHub } from "./event-hub.js";

/** Web 渠道只负责持久化回复并广播；页面发送输入走 AppManager。 */
export class WebChannel implements Channel {
  readonly id = "web";
  private sink?: InboundSink;

  constructor(
    private readonly hub: EventHub,
    private readonly chatStore: ChatStore
  ) {}

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
  }

  async send(message: OutboundMessage): Promise<void> {
    if (message.channel !== this.id) {
      throw new Error(`WebChannel 不能发送 ${message.channel} 的消息`);
    }
    const conversation = await this.chatStore.appendAssistant(
      message.conversationId,
      message.content,
      {
        ...(message.taskId !== undefined ? { taskId: message.taskId } : {}),
        sourceId: message.id,
      }
    );
    const summary = this.chatStore.summary(conversation.id);
    if (summary) {
      this.hub.publish("conversation.updated", { conversation: summary });
    }
  }
}
