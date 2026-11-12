# @aura/protocol

host、router 和不同 worker 实现之间的共享协议。

- `InboundMessage` / `OutboundMessage`：全双工渠道消息与外部去重/发送幂等 ID。
- `TaskRecord`：host 权威状态、配置快照、attempt/runId、重试时间和版本。
- `WorkerProfile`：工具、记忆、模型、推理等级、生成参数和输出格式。
- `WorkerEvent`：带 `runId + sequence` 的状态、进度、输出、结果和错误事件。
- `WorkerResult`：统一的 `summary/data/artifacts/raw` 结构。
- `Worker`：多实现、多实例 worker 的最小执行与订阅接口。
