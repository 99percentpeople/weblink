const pending = new Map<string, Promise<unknown>>();

/** Web Locks serialize imports/deletes across tabs; the repository also claims unique keys. */
export async function withContentLock<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> =>
    typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request(
          `weblink:content:${key}`,
          work,
        )
      : work();
  const previous = pending.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(run);
  pending.set(key, current);
  try {
    return await current;
  } finally {
    if (pending.get(key) === current) pending.delete(key);
  }
}
