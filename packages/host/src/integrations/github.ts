import { createHmac, timingSafeEqual } from "node:crypto";
import { createId, type InboundMessage, type OutboundMessage } from "@aura/protocol";
import type { Channel, InboundSink } from "../channel.js";

export interface WebhookRequest {
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface WebhookResponse {
  status: number;
  body: string;
}

export interface GitHubChannelOptions {
  id?: string | undefined;
  token: string;
  webhookSecret: string;
  apiBaseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
}

export class GitHubChannel implements Channel {
  readonly id: string;
  private sink?: InboundSink;
  private readonly options: GitHubChannelOptions;

  constructor(options: GitHubChannelOptions) {
    this.id = options.id ?? "github";
    this.options = options;
  }

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
  }

  async handleWebhook(request: WebhookRequest): Promise<WebhookResponse> {
    if (!this.sink) return { status: 503, body: "channel not started" };
    if (!this.validSignature(request)) return { status: 401, body: "invalid signature" };

    let payload: any;
    try {
      payload = JSON.parse(request.body);
    } catch {
      return { status: 400, body: "invalid json" };
    }
    const event = header(request.headers, "x-github-event");
    const action = payload.action;
    if (!["opened", "reopened", "edited"].includes(action)) {
      return { status: 202, body: "ignored" };
    }

    let message: InboundMessage | undefined;
    if (event === "issues" && payload.issue && payload.repository) {
      message = this.toMessage(payload, payload.issue, "issue");
    } else if (event === "pull_request" && payload.pull_request && payload.repository) {
      message = this.toMessage(payload, payload.pull_request, "pull_request");
    }
    if (!message) return { status: 202, body: "ignored" };
    message.externalId = header(request.headers, "x-github-delivery") ?? message.id;
    await this.sink(message);
    return { status: 200, body: "accepted" };
  }

  async send(message: OutboundMessage): Promise<void> {
    const repository = message.metadata?.repository;
    const number = message.metadata?.number;
    if (typeof repository !== "string" || typeof number !== "number") {
      throw new Error("GitHub 回复缺少 repository/number metadata");
    }
    const fetcher = this.options.fetch ?? fetch;
    const response = await fetcher(
      `${this.options.apiBaseUrl ?? "https://api.github.com"}/repos/${repository}/issues/${number}/comments`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "x-github-api-version": "2022-11-28",
        },
        body: JSON.stringify({ body: message.content }),
      }
    );
    if (!response.ok) throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
  }

  private toMessage(payload: any, resource: any, kind: "issue" | "pull_request"): InboundMessage {
    return {
      id: createId("github"),
      channel: this.id,
      conversationId: `${payload.repository.full_name}#${resource.number}`,
      senderId: String(resource.user?.login ?? "github"),
      content: `[${kind} #${resource.number}] ${resource.title ?? ""}\n${resource.body ?? ""}\n${resource.html_url ?? ""}`,
      kind,
      receivedAt: new Date().toISOString(),
      metadata: {
        repository: payload.repository.full_name,
        number: resource.number,
        resourceId: resource.id,
        sourceVersion: resource.updated_at,
        url: resource.html_url,
      },
    };
  }

  private validSignature(request: WebhookRequest): boolean {
    const signature = header(request.headers, "x-hub-signature-256");
    if (!signature?.startsWith("sha256=")) return false;
    const expected = `sha256=${createHmac("sha256", this.options.webhookSecret)
      .update(request.body)
      .digest("hex")}`;
    const left = Buffer.from(signature);
    const right = Buffer.from(expected);
    return left.length === right.length && timingSafeEqual(left, right);
  }
}

export function header(headers: WebhookRequest["headers"], name: string): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
