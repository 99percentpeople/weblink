import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute,
} from "workbox-precaching";
import {
  NavigationRoute,
  registerRoute,
} from "workbox-routing";
declare let self: ServiceWorkerGlobalScope;

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("install", (event) => {
  self.skipWaiting();
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
