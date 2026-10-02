import {
  handleNotificationClick,
  handleNotificationMessage,
} from "../../../src/libs/platform/notification-worker";
declare const self: ServiceWorkerGlobalScope;
self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("message", (event) => {
  event.waitUntil(
    handleNotificationMessage(event, self.registration),
  );
  if (event.data?.type === "test-click")
    event.waitUntil(
      (async () => {
        const notice = (
          await self.registration.getNotifications()
        ).find((item) => item.tag === event.data.tag);
        if (!notice)
          throw new Error("Missing OS notification");
        await handleNotificationClick(
          new NotificationEvent("notificationclick", {
            notification: notice,
            action: event.data.action,
          }),
          self.clients,
        );
        event.ports[0]?.postMessage("done");
      })(),
    );
});
self.addEventListener("notificationclick", (event) =>
  event.waitUntil(
    handleNotificationClick(event, self.clients),
  ),
);
