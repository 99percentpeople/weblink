/** Wait for local ownership to become free, then make an ordinary guarded join. */
export class RoomConflictRecovery {
  private controller: AbortController | undefined;
  private joining = false;

  constructor(
    private readonly options: {
      waitUntilAvailable(
        signal: AbortSignal,
      ): Promise<boolean>;
      join(): Promise<void>;
      cancelJoin(): void;
      onRestored(): void;
      onError(error: unknown): void;
    },
  ) {}

  start(): void {
    if (this.controller) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.run(controller);
  }

  stop(): void {
    const controller = this.controller;
    this.controller = undefined;
    controller?.abort();
    if (this.joining) {
      this.joining = false;
      this.options.cancelJoin();
    }
  }

  private async run(
    controller: AbortController,
  ): Promise<void> {
    const current = () =>
      this.controller === controller &&
      !controller.signal.aborted;
    try {
      while (current()) {
        if (
          !(await this.options.waitUntilAvailable(
            controller.signal,
          )) ||
          !current()
        )
          return;
        this.joining = true;
        try {
          await this.options.join();
        } catch (error) {
          if (!current()) return;
          this.joining = false;
          // The snapshot can become stale: another waiting page may win the lock.
          if (
            error instanceof Error &&
            error.message ===
              "Room is already open in another tab"
          )
            continue;
          throw error;
        }
        if (!current()) return;
        this.joining = false;
        this.controller = undefined;
        this.options.onRestored();
        return;
      }
    } catch (error) {
      if (current()) this.options.onError(error);
    } finally {
      if (this.controller === controller) {
        this.joining = false;
        this.controller = undefined;
      }
    }
  }
}
