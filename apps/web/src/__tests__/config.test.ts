import { describe, expect, it } from "vitest";
import {
  configIssues,
  defaultConfig,
  getSecretStatus,
  isModelConfigured,
  mergeConfigSecrets,
  normalizeConfig,
  publicConfig,
} from "../config.js";

describe("normalizeConfig", () => {
  it("provides a usable default configuration", () => {
    const result = normalizeConfig(defaultConfig(), { strict: true });
    expect(result.config.workers).toHaveLength(1);
    expect(result.config.workers[0]!.id).toBe("general");
    expect(result.config.router.defaultWorkerId).toBe("general");
    expect(result.config.integrations.github.enabled).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it("rejects enabled integrations without credentials in strict mode", () => {
    const config = defaultConfig();
    config.integrations.github.enabled = true;
    config.integrations.notion.enabled = true;
    const result = normalizeConfig(config, { strict: true });
    expect(result.errors.join("\n")).toContain("GitHub 需要 Token");
    expect(result.errors.join("\n")).toContain("Notion 需要 Integration Token");
  });

  it("accepts a fully configured integration", () => {
    const config = defaultConfig();
    config.integrations.github.enabled = true;
    config.integrations.github.token = "token";
    config.integrations.github.webhookSecret = "secret";
    config.model.apiKey = "key";
    config.model.model = "mock";
    const result = normalizeConfig(config, { strict: true });
    expect(result.errors).toEqual([]);
    expect(isModelConfigured(result.config)).toBe(true);
    expect(configIssues(result.config)).toEqual([]);
  });

  it("repairs duplicate workers and a missing default worker when loading", () => {
    const config = defaultConfig();
    config.workers.push({ ...config.workers[0]! });
    config.router.defaultWorkerId = "missing";
    const result = normalizeConfig(config, { strict: false });
    const ids = result.config.workers.map((worker) => worker.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(result.config.router.defaultWorkerId);
    expect(result.errors).toEqual([]);
  });

  it("blocks duplicate workers and unknown default worker in strict mode", () => {
    const config = defaultConfig();
    config.workers.push({ ...config.workers[0]! });
    config.router.defaultWorkerId = "missing";
    const result = normalizeConfig(config, { strict: true });
    expect(result.errors.join("\n")).toContain("重复");
    expect(result.errors.join("\n")).toContain("默认 worker");
  });

  it("clamps out-of-range numbers with warnings", () => {
    const config = defaultConfig();
    config.router.maxConcurrentTasks = 999;
    config.router.defaultMaxAttempts = -1;
    const result = normalizeConfig(config, { strict: false });
    expect(result.config.router.maxConcurrentTasks).toBe(64);
    expect(result.config.router.defaultMaxAttempts).toBe(1);
    expect(result.warnings.join("\n")).toContain("最大并发任务");
  });

  it("validates router rules and regex patterns", () => {
    const config = defaultConfig();
    config.router.rules = [
      {
        name: "代码任务",
        priority: 10,
        match: { pattern: "^/code", kind: "message" },
        decision: { type: "dispatch", workerId: "general" },
      },
    ];
    const valid = normalizeConfig(config, { strict: true });
    expect(valid.errors).toEqual([]);
    expect(valid.config.router.rules[0]!.name).toBe("代码任务");

    const invalid = defaultConfig();
    invalid.router.rules = [
      { name: "bad", match: { pattern: "(" }, decision: { type: "dispatch" } },
    ];
    const result = normalizeConfig(invalid, { strict: true });
    expect(result.errors.join("\n")).toContain("match.pattern 无效");
  });

  it("falls back for blank data paths", () => {
    const config = defaultConfig();
    config.data.memoryPath = "";
    config.integrations.notion.cursorPath = "";
    const result = normalizeConfig(config, { strict: false });
    expect(result.config.data.memoryPath).toBe("data/memories.json");
    expect(result.config.integrations.notion.cursorPath).toBe("data/notion-cursor");
  });
});

describe("secret handling", () => {
  it("preserves secrets when omitted or empty and clears only on null", () => {
    const current = defaultConfig();
    current.model.apiKey = "model-secret";
    current.integrations.github.token = "gh-token";
    const roundTrip = publicConfig(current);
    const merged = mergeConfigSecrets(roundTrip, current) as typeof current;
    expect(merged.model.apiKey).toBe("model-secret");
    expect(merged.integrations.github.token).toBe("gh-token");

    const cleared = mergeConfigSecrets(
      {
        ...publicConfig(current),
        model: { ...publicConfig(current).model, apiKey: null },
      },
      current
    ) as Record<string, unknown>;
    const model = cleared.model as Record<string, unknown>;
    expect(model.apiKey).toBe("");
  });

  it("never exposes secret values through publicConfig", () => {
    const config = defaultConfig();
    config.model.apiKey = "model-secret";
    config.integrations.github.token = "gh-token";
    config.integrations.github.webhookSecret = "wh-secret";
    const exposed = JSON.stringify(publicConfig(config));
    expect(exposed).not.toContain("model-secret");
    expect(exposed).not.toContain("gh-token");
    expect(exposed).not.toContain("wh-secret");
    const status = getSecretStatus(config);
    expect(status["model.apiKey"].set).toBe(true);
    expect(status["model.apiKey"].hint).toBe("••••cret");
  });
});
