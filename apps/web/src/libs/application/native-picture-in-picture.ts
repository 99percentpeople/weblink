import type {
  NativePictureInPicture,
  NativePipOptions,
  NativePipState,
  NativePipSession,
} from "@weblink/platform";

/** One page owns native presentation. Serialize IPC so stale entry cannot win an exit. */
export function createNativePictureInPicture(
  api: NativePictureInPicture,
  onState: (state: NativePipState) => void,
  onError: (error: unknown) => void,
) {
  let closed = false;
  let options: NativePipOptions = {
    eligible: false,
    automatic: false,
  };
  let tail = Promise.resolve();
  const session = api
    .watch((state) => {
      if (!closed) onState(state);
    })
    .catch((error: unknown) => {
      if (!closed) onError(error);
      return undefined;
    });
  const run = (
    action: (session: NativePipSession) => Promise<void>,
  ) => {
    const next = tail.then(async () => {
      const ready = await session;
      if (!closed && ready) await action(ready);
    });
    tail = next.catch((error: unknown) => {
      if (!closed) onError(error);
    });
    return tail;
  };
  return {
    configure(next: NativePipOptions) {
      options = { ...next };
      void run((session) => session.configure(options));
    },
    enter: () =>
      run(async (session) => {
        await session.configure(options);
        if (!closed && options.eligible)
          await session.enter();
      }),
    exit: () => run((session) => session.exit()),
    drag: () => run((session) => session.drag()),
    async close() {
      if (closed) return;
      closed = true;
      // An in-flight entry must finish before releasing its page-owned watcher.
      await tail;
      const ready = await session.catch(() => undefined);
      await ready?.close().catch(onError);
    },
  };
}
