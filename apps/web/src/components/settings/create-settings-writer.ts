import { createSignal, onCleanup } from "solid-js";

/** Serialize automatic writes so an older response cannot replace a newer edit. */
export function createSettingsWriter<T, R = void>(
  write: (value: T) => Promise<R>,
) {
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  let revision = 0;
  let disposed = false;
  let queue = Promise.resolve();
  onCleanup(() => {
    disposed = true;
  });
  return {
    saving,
    error,
    clearError: () => setError(""),
    flush: () => queue.then(() => !error()),
    save(
      value: T,
      onSaved?: (result: R) => void,
    ): Promise<boolean> {
      const request = ++revision;
      setSaving(true);
      setError("");
      const operation = queue.then(async () => {
        if (request !== revision) return false;
        try {
          const result = await write(value);
          if (!disposed && request === revision)
            onSaved?.(result);
          return true;
        } catch (error) {
          if (!disposed && request === revision)
            setError(
              error instanceof Error
                ? error.message
                : String(error),
            );
          return false;
        } finally {
          if (!disposed && request === revision)
            setSaving(false);
        }
      });
      queue = operation.then(() => {});
      return operation;
    },
  };
}
