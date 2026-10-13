import type { PointerPosition } from "../domain/remote-control/pointer";

/** One active position and one replaceable pending position, independent of network RTT. */
export class FileDropPositions {
  private latest?: PointerPosition;
  private running?: Promise<void>;
  private attempt?: AbortController;
  private stopped = false;
  constructor(
    private readonly apply: (
      point: PointerPosition,
      signal: AbortSignal,
    ) => Promise<void>,
    private readonly options: {
      abortSuperseded?: boolean;
    } = {},
  ) {}

  update(point: PointerPosition): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.latest = { ...point };
    // Remove an obsolete position that is still waiting for transport submission.
    // Native work already in progress completes before the latest position runs.
    if (this.options.abortSuperseded) this.attempt?.abort();
    if (!this.running) {
      this.running = Promise.resolve().then(() =>
        this.drain(),
      );
      void this.running.catch(() => {});
    }
    return this.running;
  }
  private async drain() {
    try {
      while (!this.stopped && this.latest) {
        const point = this.latest;
        this.latest = undefined;
        const attempt = new AbortController();
        this.attempt = attempt;
        try {
          await this.apply(point, attempt.signal);
        } catch (error) {
          if (!attempt.signal.aborted) throw error;
        } finally {
          this.attempt = undefined;
        }
      }
    } finally {
      this.running = undefined;
    }
  }
  stop() {
    this.stopped = true;
    this.latest = undefined;
    this.attempt?.abort();
  }
}
