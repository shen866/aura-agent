# Aura

以 **router Agent 为决策核心** 的 multi-agent 运行时。host 负责全双工交互和确定性控制，worker 负责执行具体任务。仓库不再提供 CLI，所有配置和日常使用都通过内置 Web 控制台完成。

```text
          Web 控制台 / GitHub / GitLab / Notion
                     │  随时写入
                     ▼
              Host inbox（持久化）
                     │  时间窗 / 最大条数组批
                     ▼
        Router：确定性规则 → LLM 批量分析
                     │  dispatch / reply / cancel / ignore
                     ▼
       Host 任务状态机 → Worker 实例（可多种实现）
                     │  progress / output / status
                     │  Promise 返回 WorkerResult 或抛出错误
                     ▼
        Host 持久化终态 → worker 事件组批 → Router
                     │  wait / retry / reply / notify / cancel
                     ▼
             Host outbox → 原渠道回复
```

## 包职责

| 包 | 职责 |
| --- | --- |
| `@aura/protocol` | 消息、任务、worker 配置、事件和结构化结果协议，不依赖具体实现 |
| `@aura/router` | 两类批处理决策；规则优先，LLM 只输出经过校验的 action |
| `@aura/host` | 全双工渠道、inbox/outbox、任务持久化、并发、取消、重试和恢复 |
| `@aura/worker` | 原单 Agent 能力，以及适配统一 worker 协议的 `AgentWorker` |
| `@aura/web` | Web 控制台后端、Web 渠道、配置中心、REST/SSE API，以及 React + TypeScript 前端 |

## 快速开始

```bash
npm install
npm run dev:web
```

打开 `http://127.0.0.1:3000`，在「设置」页完成模型配置后保存并应用。也可以构建后运行：

```bash
npm run build
npm run start:web
```

启动参数：

```bash
npm run start:web -- --port 3001 --host 127.0.0.1
npm run dev:web -- --config data/config.json --chat-state data/chat-state.json
```

可用参数：`--port`、`--host`、`--config`、`--chat-state`、`--help`。默认只监听 `127.0.0.1`。

## Web 控制台

前端使用 React + TypeScript 组件化实现，由 Vite 构建；对话、Worker 监控与设置页共享统一的 Bootstrap/SSE 状态管理，并复用同源 REST API。

### 对话

- 消息写入 Web 渠道后进入 host inbox，由 router 批处理；最终回复经 outbox 回到当前对话。
- 对话记录持久化在 `data/chat-state.json`（原子替换，文件权限 600）。
- worker 的流式输出通过 SSE 实时展示；任务失败、重试与取消都会反映在执行状态条中。
- 支持新建/删除对话、取消执行中的任务。删除对话会取消该对话下仍在执行的任务。

### Worker 监控

- 统计卡片：全部、运行中、排队中、等待重试、成功、失败。
- 任务表支持状态、worker 与关键字筛选。
- 任务详情展示输入、结果/错误、原任务配置快照、origin、metadata、artifacts，以及 worker 的 status/progress/output/result/error 时间线。
- 可直接取消任务。流式时间线保存在内存中，服务重启后仅恢复任务权威状态，不恢复 token 级历史。

### 设置

设置页保存后立即重启 host 生效。由于重启会取消排队/运行中的任务，页面会二次确认。

| 分组 | 内容 |
| --- | --- |
| 模型服务 | API 格式、API Key、Base URL、模型、router 模型、默认 temperature/top_p，可测试连接 |
| Host 与 Router | 默认 worker、最大尝试次数、重试延迟、批处理、并发、超时、outbox、LLM 事件决策开关 |
| Workers | 增删 worker、模型、能力、推理强度、输出格式、工具白/黑名单、记忆权限、生成参数、system prompt |
| GitHub | 启用开关、Token、Webhook Secret、API Base URL、Webhook 地址、Token 验证 |
| GitLab | 启用开关、Token、Webhook Token、API Base URL、Webhook 地址、Token 验证 |
| Notion | 启用开关、Integration Token、Database ID、轮询间隔、初始游标、游标文件、Token 验证 |
| 数据与高级 | host/memory/skills 路径、记忆容量、MCP 服务器 JSON、router 规则 JSON |

所有配置写入 `data/config.json`，包括渠道 Token 等 secret。API 返回设置时会对 secret 脱敏；留空提交会保留原值，只有显式「清除」才会删除。**不要提交 `data/` 或配置文件。**

当前 Provider 实现为 OpenAI 兼容协议；Anthropic 与 Gemini 在 `@aura/worker` 中尚未实现，选择后设置页会提示，对话会被阻止。

### 配置示例

设置页会生成完整配置，通常无需手写。worker 与路由规则示例：

```json
{
  "model": {
    "format": "openai",
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "routerModel": ""
  },
  "router": {
    "defaultWorkerId": "general",
    "defaultMaxAttempts": 2,
    "maxConcurrentTasks": 4,
    "rules": [
      {
        "name": "代码任务",
        "priority": 10,
        "match": { "pattern": "^/code\\s", "kind": "message" },
        "decision": { "type": "dispatch", "workerId": "coder", "maxAttempts": 3 }
      }
    ]
  },
  "workers": [
    {
      "id": "general",
      "description": "通用对话和事务处理",
      "capabilities": ["chat", "tools"],
      "reasoningEffort": "medium",
      "outputFormat": "text",
      "tools": { "allow": [], "deny": ["bash"] },
      "memory": { "read": true, "write": false },
      "generation": { "temperature": 0.7, "topP": 1, "maxTokens": null }
    },
    {
      "id": "coder",
      "description": "代码分析与修改",
      "capabilities": ["code", "git"],
      "model": "deepseek-chat",
      "reasoningEffort": "high",
      "outputFormat": "json",
      "systemPrompt": "你是代码 worker，只处理软件工程任务。",
      "tools": { "allow": ["bash", "calculator"], "deny": [] },
      "memory": { "read": true, "write": true },
      "generation": { "temperature": 0.1, "topP": null, "maxTokens": null }
    }
  ]
}
```

权限在两层执行：模型看到的 tool schema 会被过滤，实际 `execute` 也会再次拒绝未授权工具。`memory.read=false` 禁止自动检索和记忆读工具，`memory.write=false` 禁止保存/删除记忆。`outputFormat=json` 时结果必须是包含非空 `summary` 的 JSON 对象，可选 `data`、`artifacts`。

未命中规则的输入会合并为一次 LLM 请求。`useLlmForWorkerEvents=true` 可让 LLM 分析执行事件批次；默认使用确定性终态/重试策略，避免为 token delta 反复调用模型。规则中的正则和必需字段在保存前由服务端校验。

## GitHub / GitLab / Notion 接入

全部在设置页配置，不再读取 `GITHUB_TOKEN`、`NOTION_TOKEN` 等环境变量。Webhook 与 Web 控制台共享 HTTP 端口：

- GitHub：启用后填写 Token 与 Webhook Secret；把 Webhook 指向 `http://<host>:<port>/webhooks/github`，事件选择 issues / pull requests。回复写入对应 issue 评论，`x-github-delivery` 用于去重。
- GitLab：填写 Token 与 Webhook Token；Webhook 指向 `/webhooks/gitlab`。支持 issue 与 merge request，回复写入 note。
- Notion：填写 Integration Token 与 Database ID；服务轮询数据库页面更新并回写页面评论。游标默认持久化到 `data/notion-cursor`，可在设置页修改。

Webhook 只有在 inbox 持久化成功后才返回 2xx；非 2xx 由平台重投，host 按 `(channel, externalId)` 去重。渠道未启用或 host 未就绪时返回 503，避免误确认。

## MCP / Skills / 记忆

- MCP 服务器在设置页的「数据与高级」中编辑 JSON 数组，示例见 [`mcp.example.json`](mcp.example.json)。
- Skills：设置目录，目录下每个子目录放一个 `SKILL.md`；留空关闭。
- 记忆：`FileMemoryStorage` 写入设置中的记忆文件，`memoryLimit` 和 `maxMemories` 控制检索条数与容量。

## 脚本

```bash
npm run dev:web      # 构建依赖包与 React 前端并启动 Web 控制台（tsx watch）
npm run build        # 构建所有包、Web 后端与 React 前端
npm run build:web    # 只构建 Web 后端和 Vite 前端产物
npm run start:web    # 运行构建后的 Web 控制台
npm test             # vitest
npm run typecheck    # 所有 workspace
npm run lint
```

## HTTP API

Web 控制台自身使用同源 REST/SSE API，也便于脚本化：

- `GET /api/bootstrap`：状态、脱敏配置、secret 状态、对话摘要、最近任务
- `GET /api/status` / `GET /api/config`
- `PUT /api/config`：校验并应用配置（会重启 host）
- `POST /api/config/validate`：只校验
- `GET /api/tasks` / `GET /api/tasks/:id` / `POST /api/tasks/:id/cancel`
- `GET|POST /api/conversations`、`GET|DELETE /api/conversations/:id`
- `POST /api/conversations/:id/messages`
- `GET /api/events`：SSE，事件包括 `status`、`task.updated`、`worker.event`、`message.sent`、`conversation.updated`、`config.updated`
- `POST /api/model/test` 与 `POST /api/integrations/:kind/test`（凭据验证）
- `POST /webhooks/github`、`POST /webhooks/gitlab`

## 状态与可靠性语义

- 状态机：`queued → running → succeeded/failed`，失败可进入 `retry_wait`；运行中取消经过 `cancel_requested`，排队任务可直接取消。
- 每次 dispatch/重试生成新 `runId`。host 只接收当前运行的进度，旧 attempt 的迟到事件不会覆盖任务或通知用户。
- 输入、任务配置快照、执行次数、重试时间和 outbox 使用 JSON 原子替换持久化。默认文件为 `data/host-state.json`。若进程在终态提交后、事件路由前崩溃，重启会从任务记录重建结果通知或失败重试。
- 当前恢复模型是**单进程、干净上下文的任务级重跑**，不是 ReAct 中间状态恢复。重跑具有副作用的工具前，应在自定义工具中使用跨 attempt 稳定的业务幂等键。
- 取消信号会传给 Provider、bash 和 MCP 工具。不响应 abort 的自定义 worker 不能声称外部副作用已停止；host 默认等待 5 秒（设置页可改）后完成控制面停止，并保留 `cancel_requested` 供下次恢复。
- 采用 at-least-once + 去重，不承诺端到端 exactly-once。渠道发送成功但 host 在 outbox ack 前崩溃时，不支持发送幂等键的外部渠道仍可能出现重复评论。
- token/output 和进度事件是瞬时通知，可合并或丢失；权威终态只来自 host 对 `Worker.run()` Promise 的提交。
- 配置热更新会停止 host 并取消执行中的任务；正在执行的 worker 若无响应会有停止超时。生产多实例部署应替换 `HostStore` 为带事务、租约和 CAS 的共享存储。

## 安全说明

Web 控制台目前是**单用户本地控制台**，没有登录鉴权。默认只监听 `127.0.0.1`；如需暴露到网络，请在前面加认证反向代理并限制来源。配置文件和对话记录包含敏感信息，权限已设为 600，且 `data/` 已被 `.gitignore` 忽略。

## License

ISC
