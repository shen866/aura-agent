import type { ToolPolicy } from "@aura/protocol";
import type { ToolSource } from "../agent/ports/tool.js";
import type { ChatCompletionTool, ToolExecutionContext } from "../types/types.js";

const MEMORY_READ_TOOLS = new Set(["memory_search", "memory_list"]);
const MEMORY_WRITE_TOOLS = new Set(["memory_save", "memory_delete"]);

export function isToolAllowed(
  name: string,
  policy: ToolPolicy,
  memory: { read: boolean; write: boolean }
): boolean {
  if (policy.deny?.includes(name)) return false;
  if (policy.allow && !policy.allow.includes(name)) return false;
  if (!memory.read && MEMORY_READ_TOOLS.has(name)) return false;
  if (!memory.write && MEMORY_WRITE_TOOLS.has(name)) return false;
  return true;
}

/** 在模型 schema 和实际执行两处强制权限，避免仅靠提示词限制工具。 */
export class PolicyToolSource implements ToolSource {
  constructor(
    private readonly source: ToolSource,
    private readonly tools: ToolPolicy,
    private readonly memory: { read: boolean; write: boolean }
  ) {}

  getToolSchemas(): ChatCompletionTool[] {
    return this.source
      .getToolSchemas()
      .filter((schema) => isToolAllowed(schema.function.name, this.tools, this.memory));
  }

  async execute(
    name: string,
    args: Record<string, any>,
    context?: ToolExecutionContext
  ): Promise<string> {
    if (!isToolAllowed(name, this.tools, this.memory)) {
      throw new Error(`工具 ${name} 未被当前 worker 配置授权`);
    }
    return context ? this.source.execute(name, args, context) : this.source.execute(name, args);
  }
}
