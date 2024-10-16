import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import {
  NavigationRoute,
  registerRoute,
} from "workbox-routing";
import { CacheFirst } from "workbox-strategies";
import { CacheableResponsePlugin } from "workbox-cacheable-response";
import { ExpirationPlugin } from "workbox-expiration";

declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("install", () => {
  self.skipWaiting();
  // send notification to user
  self.registration.showNotification("Weblink", {
    body: "Weblink is ready to use",
  });
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING")
    self.skipWaiting();
});

// clean old assets
cleanupOutdatedCaches();

// to allow work offline
registerRoute(
  new NavigationRoute(
    createHandlerBoundToURL("index.html"),
  ),
);

// 缓存 i18n JSON 文件
registerRoute(
  ({ request }) =>
    request.url.includes("/i18n/") &&
    request.url.endsWith(".json"),
  new CacheFirst({
    cacheName: "i18n-cache",
    plugins: [
      new CacheableResponsePlugin({
        statuses: [0, 200],
      }),
      new ExpirationPlugin({
        maxEntries: 10, // 最多缓存10个文件
        maxAgeSeconds: 30 * 24 * 60 * 60, // 30天后过期
      }),
    ],
  }),
);
