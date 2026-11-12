import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AppManager } from "../app-manager.js";
import { ChatStore } from "../chat-store.js";
import { defaultConfig } from "../config.js";
import { EventHub } from "../event-hub.js";
import { PUBLIC_ROOT } from "../paths.js";
import { startWebServer } from "../server.js";

const directories: string[] = [];

async function setup(): Promise<{
  manager: AppManager;
  hub: EventHub;
  configPath: string;
  dir: string;
}> {
  const dir = await mkdtemp(path.join(tmpdir(), "aura-app-"));
  directories.push(dir);
  const config = defaultConfig();
  config.data.hostStatePath = path.join(dir, "host-state.json");
  config.data.memoryPath = path.join(dir, "memories.json");
  config.data.skillsPath = "";
  const configPath = path.join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
  const hub = new EventHub();
  const manager = new AppManager({
    configPath,
    hub,
    chatStore: new ChatStore(path.join(dir, "chat-state.json")),
    log: () => undefined,
  });
  await manager.load();
  await manager.start();
  return { manager, hub, configPath, dir };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AppManager", () => {
  it("starts without model credentials and blocks chat until configured", async () => {
    const { manager, hub } = await setup();
    try {
      const status = manager.status();
      expect(status.state).toBe("running");
      expect(status.model.configured).toBe(false);
      expect(status.issues.join("\n")).toContain("API Key");
      await expect(manager.sendChat("conv", "hello")).rejects.toMatchObject({ status: 409 });
    } finally {
      await manager.stop();
      hub.close();
    }
  });

  it("applies a model config, persists secrets and preserves them on round-trip", async () => {
    const { manager, hub, configPath } = await setup();
    try {
      const next = defaultConfig();
      next.model.apiKey = "secret-model-key";
      next.model.model = "mock-model";
      next.model.baseUrl = "http://127.0.0.1:1/v1";
      next.data.hostStatePath = manager.publicConfig().data.hostStatePath;
      next.data.memoryPath = manager.publicConfig().data.memoryPath;
      await manager.applyConfig(next);
      expect(manager.status().state).toBe("running");
      expect(manager.status().model.configured).toBe(true);
      expect(manager.secretStatus()["model.apiKey"].set).toBe(true);
      expect(manager.publicConfig().model.apiKey).toBe("");
      const saved = JSON.parse(await readFile(configPath, "utf8")) as {
        model: { apiKey: string };
      };
      expect(saved.model.apiKey).toBe("secret-model-key");

      const roundTrip = manager.publicConfig();
      roundTrip.workers[0]!.description = "round-trip";
      await manager.applyConfig(roundTrip);
      expect(manager.secretStatus()["model.apiKey"].set).toBe(true);
      expect(manager.publicConfig().workers[0]!.description).toBe("round-trip");
    } finally {
      await manager.stop();
      hub.close();
    }
  });
});

describe("Web server", () => {
  it("serves the SPA and JSON APIs", async () => {
    const { manager, hub } = await setup();
    const handle = await startWebServer({
      manager,
      hub,
      publicRoot: PUBLIC_ROOT,
      host: "127.0.0.1",
      port: 0,
    });
    try {
      const health = await fetch(`http://127.0.0.1:${handle.port}/api/health`);
      expect(health.status).toBe(200);
      const index = await fetch(`http://127.0.0.1:${handle.port}/`);
      expect(index.status).toBe(200);
      expect(index.headers.get("content-security-policy")).toContain("default-src 'self'");
      expect(await index.text()).toContain("Aura");
      const bootstrap = await fetch(`http://127.0.0.1:${handle.port}/api/bootstrap`);
      const body = (await bootstrap.json()) as {
        app: { state: string };
        config: { model: { apiKey: string } };
      };
      expect(body.app.state).toBe("running");
      expect(body.config.model.apiKey).toBe("");
    } finally {
      hub.close();
      await handle.close();
      await manager.stop();
    }
  });
});
