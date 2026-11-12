import { timingSafeEqual } from "node:crypto";
import { createId, type OutboundMessage } from "@aura/protocol";
import type { Channel, InboundSink } from "../channel.js";
import { header, type WebhookRequest, type WebhookResponse } from "./github.js";

export interface GitLabChannelOptions {
  id?: string | undefined;
  token: string;
  webhookToken: string;
  apiBaseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
}

/** GitLab issue 与 merge_request webhook，回复写入对应 note。 */
export class GitLabChannel implements Channel {
  readonly id: string;
  private sink?: InboundSink;

  constructor(private readonly options: GitLabChannelOptions) {
    this.id = options.id ?? "gitlab";
  }

  async start(sink: InboundSink): Promise<void> {
    this.sink = sink;
  }

  async handleWebhook(request: WebhookRequest): Promise<WebhookResponse> {
    if (!this.sink) return { status: 503, body: "channel not started" };
    const supplied = header(request.headers, "x-gitlab-token") ?? "";
    const left = Buffer.from(supplied);
    const right = Buffer.from(this.options.webhookToken);
    if (left.length !== right.length || !timingSafeEqual(left, right)) {
      return { status: 401, body: "invalid token" };
    }

    let payload: any;
    try {
      payload = JSON.parse(request.body);
    } catch {
      return { status: 400, body: "invalid json" };
    }
    const resource = payload.object_attributes;
    const project = payload.project;
    if (!resource || !project || !["open", "reopen", "update"].includes(resource.action)) {
      return { status: 202, body: "ignored" };
    }
    const kind =
      payload.object_kind === "merge_request"
        ? "merge_request"
        : payload.object_kind === "issue"
          ? "issue"
          : undefined;
    if (!kind) return { status: 202, body: "ignored" };

    await this.sink({
      id: createId("gitlab"),
      externalId:
        header(request.headers, "x-gitlab-event-uuid") ?? `${resource.id}:${resource.updated_at}`,
      channel: this.id,
      conversationId: `${project.path_with_namespace}#${resource.iid}`,
      senderId: String(payload.user?.username ?? "gitlab"),
      content: `[${kind} !${resource.iid}] ${resource.title ?? ""}\n${resource.description ?? ""}\n${resource.url ?? ""}`,
      kind,
      receivedAt: new Date().toISOString(),
      metadata: {
        projectId: project.id,
        iid: resource.iid,
        kind,
        resourceId: resource.id,
        sourceVersion: resource.updated_at,
        url: resource.url,
      },
    });
    return { status: 200, body: "accepted" };
  }

  async send(message: OutboundMessage): Promise<void> {
    const projectId = message.metadata?.projectId;
    const iid = message.metadata?.iid;
    const kind = message.metadata?.kind;
    if (
      (typeof projectId !== "number" && typeof projectId !== "string") ||
      typeof iid !== "number" ||
      (kind !== "issue" && kind !== "merge_request")
    ) {
      throw new Error("GitLab 回复缺少 projectId/iid/kind metadata");
    }
    const collection = kind === "merge_request" ? "merge_requests" : "issues";
    const response = await (this.options.fetch ?? fetch)(
      `${this.options.apiBaseUrl ?? "https://gitlab.com/api/v4"}/projects/${encodeURIComponent(projectId)}/${collection}/${iid}/notes`,
      {
        method: "POST",
        headers: { "private-token": this.options.token, "content-type": "application/json" },
        body: JSON.stringify({ body: message.content }),
      }
    );
    if (!response.ok) throw new Error(`GitLab API ${response.status}: ${await response.text()}`);
  }
}
