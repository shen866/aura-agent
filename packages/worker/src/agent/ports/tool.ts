import type { ChatCompletionTool, ToolExecutionContext } from "../../types/types.js";

export interface ToolSource {
  getToolSchemas(): ChatCompletionTool[];
  execute(name: string, args: Record<string, any>, context?: ToolExecutionContext): Promise<string>;
}

export class NullToolSource implements ToolSource {
  getToolSchemas() {
    return [];
  }
  execute(): Promise<string> {
    return Promise.resolve("");
  }
}
