const pending = new Map<string, Promise<unknown>>();

/** Serialize named work locally and across tabs when Web Locks are available. */
export async function withExclusiveTask<T>(
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const run = async (): Promise<T> =>
    typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request(`weblink:${key}`, work)
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
