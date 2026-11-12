# @aura/host

确定性控制面：任务持久化、状态机、投递、订阅、并发、取消、重试和恢复。

## 核心用法

```ts
const host = new Host({
  router,
  store: new FileHostStore("./data/host-state.json"),
  batchIntervalMs: 300,
  maxBatchSize: 20,
  maxConcurrentTasks: 4,
});
host.registerWorker(worker, profile);
host.registerChannel(channel);
await host.start();
```

- `ingest(message)`：去重并持久化 inbox 后 resolve，渠道此时才能 ack。
- `flush()`：测试/停机辅助，处理当前输入和 worker 事件批次，等待活动执行及可立即重试链排至静止后尝试投递 outbox；不等待未来的重试定时器。
- `cancelTask(id)`：排队任务直接取消；运行任务写入 `cancel_requested` 后 abort。
- `subscribe(listener)`：订阅 host 的任务变更、输入、输出、错误和 `worker.event` 瞬时事件（流式监控用），不替代控制面终态。
- `stop()`：停止渠道，禁止新 dispatch，排空输入，取消任务并处理终态。`stopTimeoutMs` 限制对不响应 abort 的 worker 的等待，超时任务保留 `cancel_requested`。

## 内部对象

`Host` 是对外门面和生命周期协调者，内部职责按状态归属拆分：

- `Task`：任务聚合，封装状态机、runId 隔离、取消、完成、失败和重试不变量；`TaskRecord` 仍是协议层 DTO。
- `TaskRegistry`：任务集合、恢复和查询，不向外暴露可变记录。
- `TaskDispatcher`：并发容量、worker 执行、AbortController 和重试定时器。
- `MessageIntake`：消息去重、inbox、接收 ack 和输入批次。
- `Outbox`：待投递消息、串行 drain、渠道故障隔离和投递重试。
- `HostStateCommitter`：唯一持久化提交点，汇总各对象快照并串行写入完整 `HostState`。

`MemoryHostStore` 适合测试，`FileHostStore` 使用临时文件原子替换。多进程部署需要自行实现带事务、租约和 CAS 的 `HostStore`，不能让多个 host 共享同一个 JSON 文件。

## Channel

```ts
interface Channel {
  readonly id: string;
  start(sink: (message: InboundMessage) => Promise<void>): Promise<void>;
  send(message: OutboundMessage): Promise<void>;
  stop?(): Promise<void>;
}
```

`start` 不阻塞输出；输入和 `send` 可随时独立发生。内置 `FunctionChannel`（测试/嵌入）、`GitHubChannel`、`GitLabChannel` 和 `NotionChannel`。`createWebhookServer` 是可选 Node HTTP 入口，也可在已有框架中直接调用 `handleWebhook`。
