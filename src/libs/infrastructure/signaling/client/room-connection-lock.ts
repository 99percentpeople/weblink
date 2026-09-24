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
