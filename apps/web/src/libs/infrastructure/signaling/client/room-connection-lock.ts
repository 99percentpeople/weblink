/** Keep one signaling connection per room/identity across same-origin tabs. */
export function acquireRoomConnectionLock(
  name: string,
  signal: AbortSignal,
  options: {
    takeover?: boolean;
    onReplaced(): void;
  },
): Promise<() => void> {
  const cancelled = () =>
    new DOMException(
      "Room connection cancelled",
      "AbortError",
    );
  if (signal.aborted) return Promise.reject(cancelled());
  const locks = navigator.locks;
  if (typeof locks?.request !== "function")
    return Promise.resolve(() => {});

  return new Promise((resolve, reject) => {
    let release: (() => void) | undefined;
    const waiting = new AbortController();
    const channel =
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel(name)
        : undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = () => {
      waiting.abort();
      release?.();
      reject(cancelled());
    };
    const cleanup = () => {
      clearTimeout(timer);
      channel?.close();
      signal.removeEventListener("abort", abort);
    };
    signal.addEventListener("abort", abort, { once: true });
    channel?.addEventListener("message", (event) => {
      if (event.data !== "takeover" || !release) return;
      // The previous connection exits before its lock is released.
      options.onReplaced();
      release();
    });
    const takingOver = Boolean(options.takeover && channel);
    if (takingOver) {
      timer = setTimeout(() => waiting.abort(), 5_000);
      channel!.postMessage("takeover");
    }
    // Only an explicit takeover waits for the previous page to release ownership.
    void locks
      .request(
        name,
        takingOver
          ? { signal: waiting.signal }
          : { ifAvailable: true },
        (lock) => {
          if (signal.aborted || !lock) {
            cleanup();
            reject(
              signal.aborted
                ? cancelled()
                : new Error(
                    "Room is already open in another tab",
                  ),
            );
            return;
          }
          clearTimeout(timer);
          return new Promise<void>((done) => {
            release = () => {
              cleanup();
              done();
            };
            resolve(release);
          });
        },
      )
      .catch((error: unknown) => {
        cleanup();
        reject(
          waiting.signal.aborted && !signal.aborted
            ? new Error("Room takeover timed out")
            : error,
        );
      });
  });
}

export function roomConnectionLockName(
  websocketUrl: string,
  roomId: string,
  clientId: string,
): string {
  const url = new URL(websocketUrl);
  return JSON.stringify([
    "weblink:signaling",
    url.origin,
    url.pathname,
    roomId.trim(),
    clientId,
  ]);
}

/** Observe availability without queuing ahead of an explicit takeover request. */
export function waitForRoomConnectionAvailability(
  name: string,
  signal: AbortSignal,
): Promise<boolean> {
  const cancelled = () =>
    new DOMException(
      "Room recovery cancelled",
      "AbortError",
    );
  if (signal.aborted) return Promise.reject(cancelled());
  const locks = navigator.locks;
  if (
    typeof locks?.request !== "function" ||
    typeof locks.query !== "function"
  )
    return Promise.resolve(false);
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let checking = false;
    let settled = false;
    const events = new AbortController();
    const cleanup = () => {
      settled = true;
      clearTimeout(timer);
      events.abort();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(cancelled());
    };
    const finish = (available: boolean) => {
      cleanup();
      resolve(available);
    };
    const check = async () => {
      if (settled || checking) return;
      clearTimeout(timer);
      checking = true;
      try {
        const snapshot = await locks.query();
        if (settled) return;
        if (
          ![
            ...(snapshot.held ?? []),
            ...(snapshot.pending ?? []),
          ].some((lock) => lock.name === name)
        )
          finish(true);
      } catch {
        // If querying is unavailable, keep the explicit switch action working.
        if (!settled) finish(false);
      } finally {
        checking = false;
        if (!settled)
          timer = setTimeout(() => void check(), 1_000);
      }
    };
    signal.addEventListener("abort", abort, { once: true });
    if (typeof window !== "undefined") {
      window.addEventListener("focus", check, {
        signal: events.signal,
      });
      window.addEventListener("pageshow", check, {
        signal: events.signal,
      });
    }
    if (typeof document !== "undefined")
      document.addEventListener("visibilitychange", check, {
        signal: events.signal,
      });
    void check();
  });
}
