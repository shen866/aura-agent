import type { RouterLanguageModel, RouterModelRequest } from "@aura/router";
import type { Provider } from "@aura/worker";

/** 复用 worker Provider 完成 router 的 JSON 决策请求。 */
export class ProviderRouterModel implements RouterLanguageModel {
  constructor(
    private readonly provider: Provider,
    private readonly model: string
  ) {}

  async complete(request: RouterModelRequest): Promise<string> {
    let content = "";
    let error = "";
    for await (const chunk of this.provider.chatStream({
      model: this.model,
      messages: [
        { role: "system", content: request.systemPrompt },
        { role: "user", content: request.userPrompt },
      ],
      tools: [],
      options: {
        temperature: 0,
        response_format: { type: "json_object" },
        signal: request.signal,
      },
    })) {
      if (chunk.type === "content") content += chunk.delta;
      if (chunk.type === "error") error += chunk.delta;
    }
    if (error) throw new Error(error);
    request.signal.throwIfAborted();
    return content;
  }
}
