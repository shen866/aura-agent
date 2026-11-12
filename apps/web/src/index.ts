import { AppManager } from "./app-manager.js";
import { ChatStore } from "./chat-store.js";
import { EventHub } from "./event-hub.js";
import { defaultChatStatePath, defaultConfigPath, PUBLIC_ROOT, resolveDataPath } from "./paths.js";
import { startWebServer } from "./server.js";

interface CliOptions {
  port: number;
  host: string;
  configPath: string;
  chatStatePath: string;
}

function option(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const direct = args.find((argument) => argument.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index !== -1) return args[index + 1];
  return undefined;
}

function parseOptions(args: string[]): CliOptions {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(
      [
        "Aura Web 控制台",
        "",
        "用法：aura-web [选项]",
        "",
        "  --port <port>        监听端口，默认 3000",
        "  --host <host>        监听地址，默认 127.0.0.1",
        "  --config <path>      配置文件，默认 data/config.json",
        "  --chat-state <path>  对话记录文件，默认 data/chat-state.json",
        "  --help               显示帮助",
      ].join("\n")
    );
    process.exit(0);
  }
  const port = Number(option(args, "port") ?? "3000");
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("--port 必须是 0-65535 的整数");
  }
  return {
    port,
    host: option(args, "host") ?? "127.0.0.1",
    configPath: resolveDataPath(option(args, "config") ?? defaultConfigPath()),
    chatStatePath: resolveDataPath(option(args, "chat-state") ?? defaultChatStatePath()),
  };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const hub = new EventHub();
  const chatStore = new ChatStore(options.chatStatePath);
  const manager = new AppManager({
    configPath: options.configPath,
    hub,
    chatStore,
  });
  await manager.load();
  const server = await startWebServer({
    manager,
    hub,
    publicRoot: PUBLIC_ROOT,
    host: options.host,
    port: options.port,
  });
  const displayHost =
    options.host === "0.0.0.0" || options.host === "::" ? "127.0.0.1" : options.host;
  console.log(`Aura Web 控制台：http://${displayHost}:${server.port}`);
  console.log(`配置文件：${options.configPath}`);
  await manager.start();
  const status = manager.status();
  if (status.issues.length > 0) {
    console.log(`待配置：${status.issues.join("；")}`);
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${signal}，正在关闭…`);
    hub.close();
    try {
      await server.close();
    } catch (error) {
      console.error(
        `关闭 HTTP 服务失败：${error instanceof Error ? error.message : String(error)}`
      );
    }
    try {
      await manager.stop();
    } catch (error) {
      console.error(`关闭 Host 失败：${error instanceof Error ? error.message : String(error)}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  console.error(
    "\x1b[31m❌ 程序发生错误:\x1b[0m",
    error instanceof Error ? error.message : String(error)
  );
  process.exitCode = 1;
});
