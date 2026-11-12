import type { WorkerProfile } from "@aura/protocol";
import { BatchRouter, LlmRouterPlanner, type RouteRule, type RouterPlanner } from "@aura/router";
import {
  FileHostStore,
  FileNotionCursorStore,
  GitHubChannel,
  GitLabChannel,
  Host,
  NotionChannel,
  type WebhookChannelAdapter,
} from "@aura/host";
import {
  AgentWorker,
  createDefaultRegistry,
  createProvider,
  FileMemoryStorage,
  MemoryManager,
  SkillRegistry,
  SYSTEM_PROMPT,
  type MCPClientManager,
  type Provider,
} from "@aura/worker";
import type { AppConfig, WorkerSettings } from "./config.js";
import { resolveDataPath } from "./paths.js";
import { ProviderRouterModel } from "./router-model.js";
import { WebChannel } from "./web-channel.js";
import type { ChatStore } from "./chat-store.js";
import type { EventHub } from "./event-hub.js";

export interface WebhookRoute {
  channel: "github" | "gitlab";
  path: string;
  active: boolean;
  adapter?: WebhookChannelAdapter | undefined;
}

export interface RuntimeBuild {
  host: Host;
  workers: WorkerProfile[];
  channels: string[];
  webhooks: WebhookRoute[];
  dispose: () => Promise<void>;
}

export interface RuntimeDeps {
  hub: EventHub;
  chatStore: ChatStore;
  log: (message: string) => void;
}

/** 将配置快照转换为 host 任务携带的不可变 profile。 */
export function toWorkerProfile(settings: WorkerSettings, globalModel: string): WorkerProfile {
  const model = settings.model || globalModel;
  const generation: Record<string, unknown> = {};
  if (settings.generation.temperature !== null) {
    generation.temperature = settings.generation.temperature;
  }
  if (settings.generation.topP !== null) {
    generation.top_p = settings.generation.topP;
  }
  if (settings.generation.maxTokens !== null) {
    generation.max_tokens = settings.generation.maxTokens;
  }
  return {
    id: settings.id,
    description: settings.description,
    capabilities: settings.capabilities,
    ...(model ? { model } : {}),
    ...(settings.reasoningEffort ? { reasoningEffort: settings.reasoningEffort } : {}),
    outputFormat: settings.outputFormat,
    ...(settings.systemPrompt ? { systemPrompt: settings.systemPrompt } : {}),
    tools: {
      ...(settings.tools.allow.length > 0 ? { allow: settings.tools.allow } : {}),
      ...(settings.tools.deny.length > 0 ? { deny: settings.tools.deny } : {}),
    },
    memory: { read: settings.memory.read, write: settings.memory.write },
    generation,
  };
}

function createModelProvider(config: AppConfig): Provider {
  const key = config.model.apiKey || "aura-not-configured";
  const baseUrl = config.model.baseUrl || "https://api.openai.com/v1";
  return createProvider(config.model.format, key, baseUrl);
}

async function loadSkills(config: AppConfig): Promise<SkillRegistry | undefined> {
  if (!config.data.skillsPath.trim()) return undefined;
  return SkillRegistry.fromDirectory(resolveDataPath(config.data.skillsPath), {
    maxActiveSkills: 3,
  });
}

export async function buildRuntime(config: AppConfig, deps: RuntimeDeps): Promise<RuntimeBuild> {
  const provider = createModelProvider(config);
  const memoryManager = new MemoryManager({
    storage: new FileMemoryStorage(resolveDataPath(config.data.memoryPath)),
    defaultLimit: config.data.memoryLimit,
    maxEntries: config.data.maxMemories,
  });
  let mcpManager: MCPClientManager | undefined;
  const registry = await createDefaultRegistry({
    memoryManager,
    ...(config.data.mcpServers.length > 0
      ? { mcpConfig: { servers: config.data.mcpServers } }
      : {}),
    onMcpManager: (manager) => {
      mcpManager = manager;
    },
  });
  const skills = await loadSkills(config);

  const planner: RouterPlanner = new LlmRouterPlanner({
    model: new ProviderRouterModel(
      provider,
      config.model.routerModel || config.model.model || "aura-unconfigured-model"
    ),
    timeoutMs: config.router.plannerTimeoutMs,
  });

  const router = new BatchRouter({
    defaultWorkerId: config.router.defaultWorkerId,
    defaultMaxAttempts: config.router.defaultMaxAttempts,
    retryDelayMs: config.router.retryDelayMs,
    notifyProgress: config.router.notifyProgress,
    useLlmForWorkerEvents: config.router.useLlmForWorkerEvents,
    planner,
    rules: config.router.rules as unknown as RouteRule[],
  });

  const host = new Host({
    router,
    store: new FileHostStore(resolveDataPath(config.data.hostStatePath)),
    batchIntervalMs: config.router.batchIntervalMs,
    maxBatchSize: config.router.maxBatchSize,
    maxConcurrentTasks: config.router.maxConcurrentTasks,
    stopTimeoutMs: config.router.stopTimeoutMs,
    outboxRetryMs: config.router.outboxRetryMs,
  });

  const channels: string[] = [];
  const webhooks: WebhookRoute[] = [];

  const webChannel = new WebChannel(deps.hub, deps.chatStore);
  host.registerChannel(webChannel);
  channels.push(webChannel.id);

  const github = config.integrations.github;
  if (github.enabled && github.token && github.webhookSecret) {
    const channel = new GitHubChannel({
      token: github.token,
      webhookSecret: github.webhookSecret,
      apiBaseUrl: github.apiBaseUrl,
    });
    host.registerChannel(channel);
    channels.push(channel.id);
    webhooks.push({
      channel: "github",
      path: "/webhooks/github",
      active: true,
      adapter: channel,
    });
  } else {
    webhooks.push({ channel: "github", path: "/webhooks/github", active: false });
  }

  const gitlab = config.integrations.gitlab;
  if (gitlab.enabled && gitlab.token && gitlab.webhookToken) {
    const channel = new GitLabChannel({
      token: gitlab.token,
      webhookToken: gitlab.webhookToken,
      apiBaseUrl: gitlab.apiBaseUrl,
    });
    host.registerChannel(channel);
    channels.push(channel.id);
    webhooks.push({
      channel: "gitlab",
      path: "/webhooks/gitlab",
      active: true,
      adapter: channel,
    });
  } else {
    webhooks.push({ channel: "gitlab", path: "/webhooks/gitlab", active: false });
  }

  const notion = config.integrations.notion;
  if (notion.enabled && notion.token && notion.databaseId) {
    const channel = new NotionChannel({
      token: notion.token,
      databaseId: notion.databaseId,
      pollIntervalMs: notion.pollIntervalMs,
      ...(notion.initialCursor ? { initialCursor: notion.initialCursor } : {}),
      cursorStore: new FileNotionCursorStore(resolveDataPath(notion.cursorPath)),
      onError: (error) => deps.log(`Notion 轮询失败：${error.message}`),
    });
    host.registerChannel(channel);
    channels.push(channel.id);
  }

  const profiles: WorkerProfile[] = [];
  for (const settings of config.workers) {
    const profile = toWorkerProfile(settings, config.model.model);
    const worker = new AgentWorker({
      id: profile.id,
      profile,
      runtime: {
        provider,
        model: profile.model ?? config.model.model,
        systemPrompt: SYSTEM_PROMPT,
        tools: registry,
        memory: memoryManager,
        ...(skills ? { skills } : {}),
        generation: {
          temperature: config.model.defaultTemperature,
          top_p: config.model.defaultTopP,
        },
      },
    });
    host.registerWorker(worker, profile);
    profiles.push(profile);
  }

  return {
    host,
    workers: profiles,
    channels,
    webhooks,
    dispose: async () => {
      await mcpManager?.disconnect();
    },
  };
}
