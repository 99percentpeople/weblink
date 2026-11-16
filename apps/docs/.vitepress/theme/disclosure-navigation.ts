import {
  getScrollOffset,
  onContentUpdated,
  useRoute,
} from "vitepress";
import { onMounted, onUnmounted } from "vue";

/** Keep search results and old section links usable inside native details. */
export function useDisclosureNavigation(): void {
  if (typeof window === "undefined") return;
  const route = useRoute();
  let events: AbortController | undefined;
  let frame: number | undefined;

  const reveal = () => {
    const hash = window.location.hash;
    let id: string;
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return;
    }
    if (!id) return;
    const target = document.getElementById(id);
    if (!target) return;

    let details = target.closest("details");
    let opened = false;
    while (details) {
      if (!details.open) {
        details.open = true;
        opened = true;
      }
      details =
        details.parentElement?.closest("details") ?? null;
    }
    if (!opened) return;
    if (frame !== undefined) cancelAnimationFrame(frame);
    // VitePress may already have measured a closed section for this navigation.
    frame = requestAnimationFrame(() => {
      frame = undefined;
      if (
        !target.isConnected ||
        window.location.hash !== hash
      )
        return;
      window.scrollTo({
        top:
          window.scrollY +
          target.getBoundingClientRect().top -
          getScrollOffset(),
        behavior: "auto",
      });
    });
  };

  onContentUpdated(reveal);
  onMounted(() => {
    events = new AbortController();
    window.addEventListener("hashchange", reveal, {
      signal: events.signal,
    });
    window.addEventListener(
      "click",
      (event) => {
        if (
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        const link =
          event.target instanceof Element
            ? event.target.closest("a[href]")
            : null;
        if (
          !link ||
          link.hasAttribute("target") ||
          link.hasAttribute("download")
        )
          return;
        const to = new URL(
          link.getAttribute("href")!,
          link.baseURI,
        );
        // Clicking the current hash again does not emit hashchange.
        if (
          to.origin === location.origin &&
          to.pathname === route.path &&
          to.hash === location.hash
        )
          reveal();
      },
      { signal: events.signal },
    );
    reveal();
  });
  onUnmounted(() => {
    events?.abort();
    if (frame !== undefined) cancelAnimationFrame(frame);
  });
}
