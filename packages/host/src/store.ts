import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InboundMessage, OutboundMessage, TaskRecord } from "@aura/protocol";

export interface HostState {
  tasks: TaskRecord[];
  inbox: InboundMessage[];
  outbox: OutboundMessage[];
  processedMessageKeys: string[];
}

export interface HostStore {
  read(): Promise<HostState>;
  write(state: HostState): Promise<void>;
}

export function emptyHostState(): HostState {
  return { tasks: [], inbox: [], outbox: [], processedMessageKeys: [] };
}

function cloneState(state: HostState): HostState {
  return structuredClone(state);
}

function normalizeState(state: Partial<HostState> | undefined): HostState {
  return {
    tasks: state?.tasks ?? [],
    inbox: state?.inbox ?? [],
    outbox: state?.outbox ?? [],
    processedMessageKeys: state?.processedMessageKeys ?? [],
  };
}

export class MemoryHostStore implements HostStore {
  private state: HostState;

  constructor(initial?: Partial<HostState>) {
    this.state = cloneState(normalizeState(initial));
  }

  async read(): Promise<HostState> {
    return cloneState(this.state);
  }

  async write(state: HostState): Promise<void> {
    this.state = cloneState(state);
  }
}

/** 单进程 JSON 持久化，使用临时文件 + 原子替换避免半写文件。 */
export class FileHostStore implements HostStore {
  constructor(private readonly filePath: string) {}

  async read(): Promise<HostState> {
    try {
      return normalizeState(
        JSON.parse(await readFile(this.filePath, "utf8")) as Partial<HostState>
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyHostState();
      throw new Error(
        `读取 host 状态失败：${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  async write(state: HostState): Promise<void> {
    const directory = path.dirname(this.filePath);
    await mkdir(directory, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, JSON.stringify(state, null, 2), "utf8");
    await rename(temporary, this.filePath);
  }
}
