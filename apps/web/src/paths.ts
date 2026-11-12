import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 仓库根目录：源码与 dist 下相对层级一致。 */
export const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const BUILT_PUBLIC_ROOT = path.resolve(PROJECT_ROOT, "apps/web/dist/client");

/** 生产与开发均优先使用 Vite 构建产物；测试未构建时回退到 React 源入口。 */
export const PUBLIC_ROOT = existsSync(BUILT_PUBLIC_ROOT)
  ? BUILT_PUBLIC_ROOT
  : path.resolve(PROJECT_ROOT, "apps/web/client");

/** 配置中的相对路径按仓库根目录解析，避免 npm workspace cwd 差异。 */
export function resolveDataPath(value: string): string {
  const text = value.trim();
  if (!text) return PROJECT_ROOT;
  const expanded = text.startsWith("~/") ? path.join(os.homedir(), text.slice(2)) : text;
  return path.isAbsolute(expanded) ? expanded : path.resolve(PROJECT_ROOT, expanded);
}

export function defaultConfigPath(): string {
  return resolveDataPath("data/config.json");
}

export function defaultChatStatePath(): string {
  return resolveDataPath("data/chat-state.json");
}
