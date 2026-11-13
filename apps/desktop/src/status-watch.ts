import { Channel, invoke } from "@tauri-apps/api/core";
import { SubscriptionScope } from "@weblink/platform/subscription-scope";
import type {
  SubscriptionOptions,
  Unsubscribe,
} from "@weblink/platform/events";

/** Each subscription owns its channel; late registration and events stay scoped. */
export async function watchStatus<T>(
  command: string,
  args: Record<string, unknown>,
  receive: (status: T) => void,
  options?: Pick<SubscriptionOptions, "signal">,
): Promise<Unsubscribe> {
  const scope = new SubscriptionScope(
    options?.signal,
    console.error,
  );
  if (scope.signal.aborted) return () => {};
  const watchId = crypto.randomUUID();
  const events = new Channel<T>(scope.guard(receive));
  const unwatch = () =>
    invoke(`${command}_unwatch`, { ...args, watchId });
  try {
    await invoke(`${command}_watch`, {
      ...args,
      watchId,
      events,
    });
  } catch (error) {
    scope.dispose();
    await unwatch().catch(() => {});
    throw error;
  }
  scope.add(async () => {
    await unwatch();
  });
  return () => scope.dispose();
}
