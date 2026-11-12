# @aura/worker

通用任务执行器。保留原 `Agent`、`Thread`、Provider、工具、记忆和 Skill API，并新增标准 worker 适配器。

```ts
const worker = new AgentWorker({
  id: "coder",
  profile: {
    id: "coder",
    description: "代码任务",
    capabilities: ["code"],
    model: "gpt-4o",
    reasoningEffort: "high",
    outputFormat: "json",
    tools: { allow: ["bash", "calculator"], deny: [] },
    memory: { read: true, write: false },
  },
  runtime: { provider, model: "gpt-4o", tools: registry, memory },
});

host.registerWorker(worker, profile);
```

每次 `run` 创建独立 `Agent`，同一 worker 实例并发执行也不会共享 Thread。host 传入的 profile 是任务创建时的快照，可覆盖模型、推理等级、生成参数、系统提示词、工具权限、记忆权限和输出格式。

worker 可发送 `status/progress/output/result/error` 事件，所有事件包含 `taskId/runId/workerId/sequence`。host 将 `run()` Promise 作为唯一权威终态，避免 result 事件与 Promise 竞争。自定义 worker 只需实现 `@aura/protocol` 中的 `Worker` 接口，不需要使用 `AgentWorker`。

`ToolExecutionContext.signal` 会从 worker 传到 `ToolSource`/`ToolHandler`；内置 bash 和 MCP 调用支持 abort。自定义工具应检查该信号并尽快结束，无法中断外部副作用时应明确记录其不确定状态。

`outputFormat=json` 要求：

```json
{
  "summary": "给请求方的结果说明",
  "data": { "optional": true },
  "artifacts": [{ "type": "file", "name": "result.txt", "uri": "optional" }]
}
```
