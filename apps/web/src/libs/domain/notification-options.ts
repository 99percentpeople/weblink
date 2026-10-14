export interface NotificationOptions {
  enabled: boolean;
  preview: boolean;
  sound: boolean;
  messages: boolean;
  controlRequests: boolean;
  speedTestRequests: boolean;
  transfers: boolean;
  updates: boolean;
}
export const defaultNotificationOptions: NotificationOptions =
  {
    enabled: true,
    preview: true,
    sound: true,
    messages: true,
    controlRequests: true,
    speedTestRequests: true,
    transfers: true,
    updates: true,
  };
export function resolveNotificationOptions(
  value: unknown,
): NotificationOptions {
  const result = { ...defaultNotificationOptions };
  if (!value || typeof value !== "object") return result;
  for (const key of Object.keys(
    result,
  ) as (keyof NotificationOptions)[]) {
    const candidate = (value as Record<string, unknown>)[
      key
    ];
    if (typeof candidate === "boolean")
      result[key] = candidate;
  }
  return result;
}
