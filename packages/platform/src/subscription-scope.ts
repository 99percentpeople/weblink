import {
  reportEventError,
  type Unsubscribe,
} from "./events";

type Cleanup = () => void | Promise<void>;

/** Own subscriptions and late async registrations alongside DOM AbortSignals. */
export class SubscriptionScope {
  private readonly controller = new AbortController();
  private readonly cleanups = new Set<Unsubscribe>();
  readonly signal = this.controller.signal;

  constructor(
    parent?: AbortSignal,
    private readonly onError: (
      error: unknown,
    ) => void = reportEventError,
  ) {
    if (parent?.aborted) this.dispose(parent.reason);
    else if (parent) {
      const abort = () => this.dispose(parent.reason);
      parent.addEventListener("abort", abort, {
        once: true,
      });
      this.add(() =>
        parent.removeEventListener("abort", abort),
      );
    }
  }

  add(cleanup: Cleanup): Unsubscribe {
    let active = true;
    const stop = () => {
      if (!active) return;
      active = false;
      this.cleanups.delete(stop);
      try {
        const result = cleanup();
        if (result) void result.catch(this.onError);
      } catch (error) {
        this.onError(error);
      }
    };
    if (this.signal.aborted) stop();
    else this.cleanups.add(stop);
    return stop;
  }

  /** A registration finishing after disposal is released immediately, once. */
  async track(
    registration: Promise<Unsubscribe>,
  ): Promise<Unsubscribe> {
    return this.add(await registration);
  }

  guard<Args extends unknown[]>(
    listener: (...args: Args) => void,
  ): (...args: Args) => void {
    return (...args) => {
      if (!this.signal.aborted) listener(...args);
    };
  }

  dispose(reason?: unknown): void {
    if (this.signal.aborted) return;
    this.controller.abort(reason);
    for (const stop of this.cleanups) stop();
  }
}
