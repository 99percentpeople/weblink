export const DEFAULT_MAX_CONCURRENT_TRANSFERS = 3;
export const MAX_CONCURRENT_TRANSFERS = 10;

export function normalizeTransferConcurrency(
  value: number,
): number {
  return Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= MAX_CONCURRENT_TRANSFERS
    ? value
    : DEFAULT_MAX_CONCURRENT_TRANSFERS;
}

/** FIFO admission; a slot belongs to the entire run, including finalization. */
export class TransferQueue {
  private active = 0;
  private limit: number;
  private readonly pending: Array<() => void> = [];

  constructor(limit = DEFAULT_MAX_CONCURRENT_TRANSFERS) {
    this.limit = normalizeTransferConcurrency(limit);
  }

  setLimit(limit: number): void {
    this.limit = normalizeTransferConcurrency(limit);
    this.drain();
  }

  acquire(signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      signal.throwIfAborted();
      let admitted = false;
      const start = () => {
        admitted = true;
        this.active++;
        resolve();
      };
      signal.addEventListener(
        "abort",
        () => {
          if (admitted) this.active--;
          else {
            const index = this.pending.indexOf(start);
            if (index !== -1) this.pending.splice(index, 1);
            reject(signal.reason);
          }
          this.drain();
        },
        { once: true },
      );
      this.pending.push(start);
      this.drain();
    });
  }

  /** Older peers cannot wait for admission. Account for their existing work. */
  occupy(signal: AbortSignal): void {
    signal.throwIfAborted();
    this.active++;
    signal.addEventListener(
      "abort",
      () => {
        this.active--;
        this.drain();
      },
      { once: true },
    );
  }

  private drain(): void {
    while (this.active < this.limit && this.pending.length)
      this.pending.shift()!();
  }
}
