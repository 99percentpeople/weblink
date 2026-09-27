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

// @ts-ignore
self.__WB_DISABLE_DEV_LOGS = true;

precacheAndRoute(self.__WB_MANIFEST);

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING")
    self.skipWaiting();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (url.pathname === "/share") {
    if (event.request.method === "POST") {
      event.respondWith(
        (async () => {
          const formData = await event.request.formData();
          let name = formData.get("name") as
            | string
            | undefined;
          let description = formData.get("description") as
            | string
            | undefined;
          let link = formData.get("link") as
            | string
            | undefined;
          let files =
            (formData.getAll("files") as File[]) ??
            undefined;

          name = name ? decodeURI(name) : undefined;

          description = description
            ? decodeURI(description)
            : undefined;
          link = link ? decodeURI(link) : undefined;

          const data: ShareData = {
            title: name,
            text: description,
            url: link,
            files,
          };

          const clients = await self.clients.matchAll({
            includeUncontrolled: true,
            type: "window",
          });
          for (const client of clients) {
            client.postMessage({
              action: "share-target",
              data,
            });
          }

          if (clients.length === 0) {
            const redirectUrl = new URL(
              "/",
              location.origin,
            );
            return Response.redirect(redirectUrl, 303);
          } else {
            const redirectUrl = new URL(
              "/close-window",
              location.origin,
            );
            return Response.redirect(redirectUrl, 303);
          }
        })(),
      );
    }
  }
});

// Clean old assets
cleanupOutdatedCaches();

// Allow work offline
registerRoute(
  new NavigationRoute(
    createHandlerBoundToURL("index.html"),
  ),
);
