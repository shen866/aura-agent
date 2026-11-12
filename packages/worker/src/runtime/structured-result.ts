import type { WorkerResult } from "@aura/protocol";

export const STRUCTURED_OUTPUT_INSTRUCTION = `
本次回复必须且只能是一个 JSON 对象，不要使用 Markdown 代码围栏。结构如下：
{
  "summary": "面向请求方的简洁结果说明",
  "data": {},
  "artifacts": [{"type": "file|link|other", "name": "名称", "uri": "可选地址", "content": "可选内容"}]
}
summary 必填；data 和 artifacts 可按需省略。`;

export function parseStructuredResult(content: string): WorkerResult {
  const trimmed = content.trim();
  const withoutFence = trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFence);
  } catch (error) {
    throw new Error(
      `worker 未返回合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("worker 的结构化结果必须是 JSON 对象");
  }

  const value = parsed as Record<string, unknown>;
  if (typeof value.summary !== "string" || !value.summary.trim()) {
    throw new Error("worker 的结构化结果缺少非空 summary 字段");
  }

  const artifacts = value.artifacts;
  if (artifacts !== undefined && !Array.isArray(artifacts)) {
    throw new Error("worker 的 artifacts 字段必须是数组");
  }

  return {
    summary: value.summary,
    ...(value.data !== undefined ? { data: value.data } : {}),
    ...(artifacts !== undefined ? { artifacts: artifacts as WorkerResult["artifacts"] } : {}),
    raw: content,
  };
}
