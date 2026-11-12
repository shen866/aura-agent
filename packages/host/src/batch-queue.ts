export interface BatchQueueOptions<T> {
  maxWaitMs: number;
  maxBatchSize: number;
  process: (batch: T[]) => Promise<void>;
  onError: (error: Error) => void;
}

/** 固定最老事件等待时间，flush 中新到事件进入下一批。 */
export class BatchQueue<T> {
  private pending: T[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private processing: Promise<void> | undefined;
  private closed = false;

  constructor(private readonly options: BatchQueueOptions<T>) {}

  push(item: T): void {
    if (this.closed) throw new Error("batch queue 已关闭");
    this.pending.push(item);
    if (this.pending.length >= this.options.maxBatchSize) {
      this.clearTimer();
      void this.flush();
    } else {
      this.schedule();
    }
  }

  async flush(): Promise<void> {
    if (this.processing) return this.processing;
    if (this.pending.length === 0) return;

    this.clearTimer();
    this.processing = this.drain();
    try {
      await this.processing;
    } finally {
      this.processing = undefined;
      if (!this.closed) this.schedule();
    }
  }

  reopen(): void {
    if (this.processing) throw new Error("batch queue 仍在处理，不能重开");
    this.closed = false;
    this.schedule();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.clearTimer();
    await this.flush();
    if (this.processing) await this.processing;
  }

  private async drain(): Promise<void> {
    do {
      const batch = this.pending.splice(0, this.options.maxBatchSize);
      if (batch.length === 0) break;
      try {
        await this.options.process(batch);
      } catch (error) {
        this.pending.unshift(...batch);
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
        break;
      }
      // 排空调用期间已进入队列的项目；它们属于下一批，但无需再等一个时间窗。
    } while (this.pending.length > 0);
  }

  private schedule(): void {
    if (this.closed || this.timer || this.processing || this.pending.length === 0) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, this.options.maxWaitMs);
    this.timer.unref?.();
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }
}
