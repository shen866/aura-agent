# @aura/router

全双工交互的任务 Agent：理解意图、创建任务、处理后续消息、接收任务事件并决定是否通知用户。router 不直接执行 worker、修改任务或发送渠道消息。

## 两条批处理流水线

```ts
const decisions = await router.routeMessages({ messages, workers, tasks });
// dispatch / reply / ignore / cancel

const actions = await router.routeWorkerEvents({ events, workers, tasks });
// wait / retry / reply / fail / cancel / notify
```

`BatchRouter` 先按 priority 匹配确定性规则，再把未命中消息作为一个批次交给 `RouterPlanner`。`LlmRouterPlanner` 接收最小化的消息、worker 能力和活动任务上下文，要求 JSON 输出。router 会检查 message/task/worker ID、action 类型、重试次数，并确保每个任务每批最多一个后续动作。

worker 事件默认采用确定性策略：进度等待、成功回复、可恢复失败重试、终态失败/取消回复。设置 `useLlmForWorkerEvents` 后可由 LLM 批量覆盖决策；LLM 失败会回退到确定性策略。

模型通过 `RouterLanguageModel` 注入，因此 router 不依赖某个 SDK 或 worker 实现。
