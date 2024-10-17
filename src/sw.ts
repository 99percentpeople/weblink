import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import {
  NavigationRoute,
  registerRoute,
} from "workbox-routing";
import { NetworkFirst } from "workbox-strategies";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { ExpirationPlugin } from "workbox-expiration";

declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("install", () => {
  self.skipWaiting();

  if (
    "Notification" in self &&
    Notification.permission === "granted"
  ) {
    self.registration.showNotification("Weblink", {
      body: "Weblink is ready",
    });
  }
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING")
    self.skipWaiting();
});

// Clean old assets
cleanupOutdatedCaches();

// Allow work offline
registerRoute(
  new NavigationRoute(
    createHandlerBoundToURL("index.html"),
  ),
);

// Cache i18n JSON files
registerRoute(
  ({ request }) =>
    request.url.includes("/i18n/") &&
    request.url.endsWith(".json"),
  new NetworkFirst({
    cacheName: "i18n-cache",
    plugins: [
      new CacheableResponsePlugin({
        statuses: [0, 200],
      }),
      new ExpirationPlugin({
        maxEntries: 10,
        maxAgeSeconds: 30 * 24 * 60 * 60,
      }),
    ],
  }),
);
