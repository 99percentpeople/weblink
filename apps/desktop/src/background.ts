/** A shared Web Lock keeps Chromium from freezing the renderer that owns room
 * signaling and capture leases. It performs no polling and ends with the app. */
export function keepDesktopActive(
  locks: LockManager | undefined,
  signal: AbortSignal,
) {
  if (!locks || signal.aborted) return;
  void locks
    .request(
      "weblink:desktop-runtime",
      { mode: "shared", signal },
      () =>
        new Promise<void>((resolve) => {
          if (signal.aborted) resolve();
          else
            signal.addEventListener(
              "abort",
              () => resolve(),
              { once: true },
            );
        }),
    )
    .catch((error: unknown) => {
      if (!signal.aborted)
        console.warn(
          "Could not keep desktop renderer active",
          error,
        );
    });
}
