import type {
  NativeApplication,
  NativeApplicationOptions,
} from "@weblink/platform";

/** Serialize configuration so a slow older IPC cannot replace the latest choice. */
export function createApplicationSettingsSync(
  application: Pick<NativeApplication, "configure">,
  onError: (error: unknown) => void,
) {
  let pending: NativeApplicationOptions | undefined;
  let running = false;
  let closed = false;
  const flush = async () => {
    if (running) return;
    running = true;
    try {
      while (pending && !closed) {
        const options = pending;
        pending = undefined;
        try {
          await application.configure(options);
        } catch (error) {
          if (!closed) onError(error);
        }
      }
    } finally {
      running = false;
    }
  };
  return {
    update(options: NativeApplicationOptions) {
      if (closed) return;
      pending = { ...options };
      void flush();
    },
    close() {
      closed = true;
      pending = undefined;
    },
  };
}
