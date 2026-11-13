export type Unsubscribe = () => void;

export interface SubscriptionOptions {
  once?: boolean;
  signal?: AbortSignal;
}

/** Consumers receive only subscriptions; the owning service keeps publication. */
export interface EventSource<Events extends object> {
  subscribe<K extends keyof Events & string>(
    type: K,
    listener: (value: Events[K]) => unknown,
    options?: SubscriptionOptions,
  ): Unsubscribe;
}

export interface EventFailure {
  domain: string;
  type: string;
}

export function reportEventError(error: unknown): void {
  if (typeof globalThis.reportError === "function")
    globalThis.reportError(error);
  else console.error(error);
}

interface Subscription {
  receive(value: unknown): void;
  stop: Unsubscribe;
}

/** One bus per service/session, with synchronous, registration-ordered delivery. */
export class EventBus<Events extends object> {
  private readonly topics = new Map<
    keyof Events & string,
    Set<Subscription>
  >();
  private busClosed = false;
  readonly events: EventSource<Events> = {
    subscribe: (type, listener, options) =>
      this.subscribe(type, listener, options),
  };

  constructor(
    readonly domain: string,
    private readonly onError: (
      error: unknown,
      event: EventFailure,
    ) => void = reportEventError,
  ) {}

  get listenerCount(): number {
    let count = 0;
    for (const listeners of this.topics.values())
      count += listeners.size;
    return count;
  }

  subscribe<K extends keyof Events & string>(
    type: K,
    listener: (value: Events[K]) => unknown,
    { signal, once = false }: SubscriptionOptions = {},
  ): Unsubscribe {
    if (this.busClosed || signal?.aborted) return () => {};
    const listeners =
      this.topics.get(type) ?? new Set<Subscription>();
    this.topics.set(type, listeners);
    const stop = () => {
      if (!listeners.delete(subscription)) return;
      if (!listeners.size) this.topics.delete(type);
      signal?.removeEventListener("abort", stop);
    };
    const fail = (error: unknown) =>
      this.onError(error, { domain: this.domain, type });
    const subscription: Subscription = {
      stop,
      receive: (value) => {
        if (once) stop();
        try {
          // The topic and payload are correlated by subscribe/emit's public types.
          const result = listener(value as Events[K]);
          if (
            result &&
            typeof (result as PromiseLike<unknown>).then ===
              "function"
          )
            void Promise.resolve(result).catch(fail);
        } catch (error) {
          fail(error);
        }
      },
    };
    listeners.add(subscription);
    signal?.addEventListener("abort", stop, { once: true });
    return stop;
  }

  emit<K extends keyof Events & string>(
    type: K,
    value: Events[K],
  ): void {
    const listeners = this.topics.get(type);
    if (!listeners || this.busClosed) return;
    // New listeners wait for the next emission; removed listeners are skipped.
    for (const subscription of [...listeners])
      if (listeners.has(subscription))
        subscription.receive(value);
  }

  clear(): void {
    for (const listeners of this.topics.values())
      for (const subscription of listeners)
        subscription.stop();
  }

  dispose(): void {
    this.busClosed = true;
    this.clear();
  }
}
