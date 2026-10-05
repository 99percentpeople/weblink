import { Channel, invoke } from "@tauri-apps/api/core";

/** Each subscription owns its channel; late registration and events stay scoped. */
export async function watchStatus<T>(
  command: string,
  args: Record<string, unknown>,
  receive: (status: T) => void,
): Promise<() => void> {
  const watchId = crypto.randomUUID();
  let closed = false;
  const events = new Channel<T>((status) => {
    if (!closed) receive(status);
  });
  const unwatch = () =>
    invoke(`${command}_unwatch`, { ...args, watchId });
  try {
    await invoke(`${command}_watch`, {
      ...args,
      watchId,
      events,
    });
  } catch (error) {
    closed = true;
    await unwatch().catch(() => {});
    throw error;
  }
  return () => {
    if (closed) return;
    closed = true;
    void unwatch().catch(console.error);
  };
}
