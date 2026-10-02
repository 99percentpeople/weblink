/** No cold-start approval or broadcast: controls belong to a live page session. */
export async function handleNotificationClick(
  event: NotificationEvent,
  clients: Clients,
): Promise<void> {
  event.notification.close();
  const data = event.notification.data;
  if (
    data?.type !== "weblink-notification" ||
    typeof data.owner !== "string" ||
    typeof data.watchId !== "string" ||
    typeof data.id !== "string" ||
    typeof data.expiresAt !== "number" ||
    data.expiresAt <= Date.now()
  )
    return;
  const client = await clients.get(data.owner);
  if (!client || client.type !== "window") return;
  client.postMessage({
    type: "weblink-notification-action",
    watchId: data.watchId,
    id: data.id,
    action: event.action || "open",
  });
  if (!event.action)
    await (client as WindowClient)
      .focus()
      .catch(() => undefined);
}

/** Let the worker finish retraction even when the originating page is unloading. */
export async function handleNotificationMessage(
  event: ExtendableMessageEvent,
  registration: ServiceWorkerRegistration,
): Promise<void> {
  if (!event.source || !("id" in event.source)) return;
  if (event.data?.type === "weblink-notification-owner")
    event.ports[0]?.postMessage(event.source.id);
  if (
    event.data?.type !== "weblink-notification-close" ||
    typeof event.data.watchId !== "string"
  )
    return;
  for (const notification of await registration.getNotifications()) {
    if (
      notification.data?.type === "weblink-notification" &&
      notification.data.owner === event.source.id &&
      notification.data.watchId === event.data.watchId
    )
      notification.close();
  }
}
