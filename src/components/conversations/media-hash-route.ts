import {
  createMemo,
  createEffect,
  type Accessor,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";

export interface MediaHashRoute {
  conversationId: string;
  messageId: string;
}
const routeEvent = "weblink:media-route";
const historyKey = "weblinkMedia";

export function mediaHash(route: MediaHashRoute): string {
  return `#/media/${encodeURIComponent(route.conversationId)}/${encodeURIComponent(route.messageId)}`;
}

export function parseMediaHash(
  hash: string,
): MediaHashRoute | undefined {
  const match = /^#\/media\/([^/]+)\/([^/]+)$/.exec(hash);
  if (!match) return;
  try {
    const conversationId = decodeURIComponent(match[1]);
    const messageId = decodeURIComponent(match[2]);
    if (conversationId && messageId)
      return { conversationId, messageId };
  } catch {
    /* Ignore malformed links without affecting conversation navigation. */
  }
}

export function createMediaHashRoute(
  routerHash?: Accessor<string>,
) {
  const [hash, setHash] = createSignal(
    routerHash?.() ?? window.location.hash,
  );
  // Router navigation can mount a view before its pushState write reaches the URL.
  if (routerHash) createEffect(() => setHash(routerHash()));
  onMount(() => {
    const controller = new AbortController();
    const update = () => setHash(window.location.hash);
    for (const name of [
      "hashchange",
      "popstate",
      routeEvent,
    ]) {
      window.addEventListener(name, update, {
        signal: controller.signal,
      });
    }
    setHash(routerHash?.() ?? window.location.hash);
    onCleanup(() => controller.abort());
  });
  return createMemo(() => parseMediaHash(hash()));
}

export function openMediaRoute(
  route: MediaHashRoute,
  replace = false,
): void {
  const hash = mediaHash(route);
  if (hash === location.hash) return;
  const path = location.pathname + location.search;
  const state = { ...history.state };
  if (!replace)
    state[historyKey] = { path, returnHash: location.hash };
  history[replace ? "replaceState" : "pushState"](
    state,
    "",
    path + hash,
  );
  window.dispatchEvent(new Event(routeEvent));
}

export function closeMediaRoute(): void {
  if (!parseMediaHash(location.hash)) return;
  const entry = history.state?.[historyKey];
  const path = location.pathname + location.search;
  if (entry?.path === path) {
    history.back();
  } else {
    const state = { ...history.state };
    delete state[historyKey];
    history.replaceState(state, "", path);
    window.dispatchEvent(new Event(routeEvent));
  }
}
