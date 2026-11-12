import fs from "fs/promises";
import path from "path";
import type { MemoryEntry, MemoryStorage } from "./types.js";

/**
 * 基于 JSON 文件的持久化存储
 */
export class FileMemoryStorage implements MemoryStorage {
  private filePath: string;

  constructor(filePath: string = "./data/memories.json") {
    this.filePath = path.resolve(filePath);
  }

  async load(): Promise<MemoryEntry[]> {
    try {
      const data = await fs.readFile(this.filePath, "utf-8");
      return JSON.parse(data) as MemoryEntry[];
    } catch (err: any) {
      if (err.code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async save(entries: MemoryEntry[]): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(entries, null, 2), "utf-8");
    await fs.rename(temporary, this.filePath);
  }
}

/**
 * 内存存储（适合测试）
 */
export class InMemoryStorage implements MemoryStorage {
  private entries: MemoryEntry[] = [];

  async load(): Promise<MemoryEntry[]> {
    return [...this.entries];
  }

  async save(entries: MemoryEntry[]): Promise<void> {
    this.entries = [...entries];
  }
}
