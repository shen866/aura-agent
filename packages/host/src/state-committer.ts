import { MemoryHostStore, type HostState, type HostStore } from "./store.js";

export interface HostStateCommitterOptions {
  store?: HostStore | undefined;
  snapshot: () => HostState;
  onError: (error: Error) => void;
}

/** 唯一持久化提交点：汇总各领域对象的快照，并串行写入完整 HostState。 */
export class HostStateCommitter {
  private readonly store: HostStore;
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly options: HostStateCommitterOptions) {
    this.store = options.store ?? new MemoryHostStore();
  }

  read(): Promise<HostState> {
    return this.store.read();
  }

  commit(): Promise<void> {
    const snapshot = structuredClone(this.options.snapshot());
    const write = this.writeChain.then(() => this.store.write(snapshot));
    this.writeChain = write.catch((error) => {
      this.options.onError(
        new Error(
          `host 状态持久化失败：${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        )
      );
    });
    return write;
  }

  async idle(): Promise<void> {
    await this.writeChain;
  }
}
