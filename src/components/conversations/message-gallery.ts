import {
  createEffect,
  onCleanup,
  onMount,
  untrack,
  type Accessor,
} from "solid-js";
import PhotoSwipeLightbox from "photoswipe/lightbox";
// @ts-ignore The video plugin does not ship declarations.
import PhotoSwipeVideoPlugin from "photoswipe-video-plugin";
import "photoswipe/style.css";
import { t } from "@/i18n";
import {
  closeMediaRoute,
  createMediaHashRoute,
  openMediaRoute,
  parseMediaHash,
} from "./media-hash-route";

/** One delegated gallery per conversation, including newly received media. */
export function createMessageGallery(
  element: HTMLElement,
  options: {
    conversationId: Accessor<string>;
    ready: Accessor<boolean>;
    hash: Accessor<string>;
    revision: Accessor<unknown>;
    reveal(messageId: string): void;
    scrollTo(element: HTMLElement): void;
  },
) {
  const route = createMediaHashRoute(options.hash);
  onMount(() => {
    const lightbox = new PhotoSwipeLightbox({
      gallery: element,
      children:
        'a[data-message-media][data-media-ready="true"]',
      thumbSelector: "[data-media-thumbnail]",
      bgOpacity: 0.8,
      initialZoomLevel: "fit",
      closeOnVerticalDrag: true,
      pswpModule: () => import("photoswipe"),
    });
    new PhotoSwipeVideoPlugin(lightbox, {});
    lightbox.on("uiRegister", () => {
      lightbox.pswp?.ui?.registerElement({
        name: "download-button",
        order: 8,
        isButton: true,
        tagName: "a",
        title: t("common.action.download"),
        html: {
          isCustomSVG: true,
          inner:
            '<path d="M20.5 14.3 17.1 18V10h-2.2v7.9l-3.4-3.6L10 16l6 6.1 6-6.1ZM23 23H9v2h14Z" id="pswp__icn-download"/>',
          outlineID: "pswp__icn-download",
        },
        onInit: (element, pswp) => {
          const link = element as HTMLAnchorElement;
          link.target = "_blank";
          link.rel = "noopener";
          pswp.on("change", () => {
            const data = pswp.currSlide?.data;
            link.download =
              data?.element?.dataset.download ?? "";
            link.href = data?.src ?? "";
          });
        },
      });
    });
    let disposed = false;
    let pendingId: string | undefined;
    let clickedId: string | undefined;
    let routeClosing = false;
    let syncingSlide = false;
    let activeItems: HTMLAnchorElement[] = [];
    const sync = () => {
      if (disposed) return;
      const target = route();
      const pswp = lightbox.pswp;
      const closeFromRoute = () => {
        pendingId = undefined;
        clickedId = undefined;
        lightbox.shouldOpen = false;
        if (pswp?.opener.isOpen && !pswp.isDestroying) {
          routeClosing = true;
          pswp.close();
        }
      };
      if (
        !target ||
        target.conversationId !== options.conversationId()
      ) {
        closeFromRoute();
        return;
      }
      options.reveal(target.messageId);
      if (!options.ready()) return;
      const items = [
        ...element.querySelectorAll<HTMLAnchorElement>(
          'a[data-message-media][data-media-ready="true"]',
        ),
      ];
      const index = items.findIndex(
        (item) =>
          item.dataset.messageMedia === target.messageId,
      );
      if (index < 0) {
        closeFromRoute();
        return;
      }
      if (pswp) {
        if (!pswp.opener.isOpen || pswp.isDestroying)
          return;
        const currentIndex = activeItems.findIndex(
          (item) =>
            item.dataset.messageMedia === target.messageId,
        );
        if (currentIndex < 0) closeFromRoute();
        else if (pswp.currIndex !== currentIndex) {
          syncingSlide = true;
          pswp.goTo(currentIndex);
          syncingSlide = false;
        }
        return;
      }
      if (pendingId === target.messageId) return;
      if (clickedId !== target.messageId)
        options.scrollTo(items[index]);
      lightbox.options!.showHideAnimationType = items[
        index
      ].querySelector("img[data-media-thumbnail]")
        ? "zoom"
        : "fade";
      activeItems = items;
      routeClosing = false;
      if (
        lightbox.loadAndOpen(index, {
          gallery: element,
          items,
        })
      )
        pendingId = target.messageId;
      clickedId = undefined;
    };
    // A thumbnail outside the visible scrollport must not zoom from a clipped box.
    // PhotoSwipe handles missing bounds as a fade, but its filter return type omits undefined.
    // @ts-expect-error Upstream filter typing is narrower than getThumbBounds at runtime.
    lightbox.addFilter("thumbBounds", (bounds, data) => {
      const thumbnail =
        data.element?.querySelector<HTMLElement>(
          "[data-media-thumbnail]",
        );
      const viewport = element.closest(
        '[data-slot="chat-viewport"]',
      );
      if (thumbnail && viewport) {
        const rect = thumbnail.getBoundingClientRect();
        const visible = viewport.getBoundingClientRect();
        if (
          rect.top < visible.top ||
          rect.bottom > visible.bottom ||
          rect.width === 0
        )
          return undefined;
      }
      return bounds;
    });
    lightbox.on("openingAnimationEnd", sync);
    lightbox.on("change", () => {
      const pswp = lightbox.pswp;
      if (
        syncingSlide ||
        !pswp?.opener.isOpen ||
        pswp.isDestroying
      )
        return;
      const messageId =
        activeItems[pswp.currIndex]?.dataset.messageMedia;
      if (messageId)
        openMediaRoute(
          {
            conversationId: options.conversationId(),
            messageId,
          },
          true,
        );
    });
    lightbox.on("close", () => {
      const current = parseMediaHash(location.hash);
      if (
        !disposed &&
        !routeClosing &&
        current?.conversationId === options.conversationId()
      )
        closeMediaRoute();
    });
    lightbox.on("destroy", () => {
      pendingId = undefined;
      // Lightbox clears its instance after PhotoSwipe dispatches destroy.
      queueMicrotask(sync);
    });
    const controller = new AbortController();
    element.addEventListener(
      "click",
      (event) => {
        const link =
          event.target instanceof Element
            ? event.target.closest<HTMLAnchorElement>(
                "a[data-message-media]",
              )
            : null;
        if (
          !link ||
          !element.contains(link) ||
          event.button !== 0 ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        const target = parseMediaHash(link.hash);
        if (target) {
          clickedId = target.messageId;
          openMediaRoute(target);
          sync();
        }
      },
      { signal: controller.signal },
    );
    // Cache hydration and media metadata may arrive after the hash or history slice.
    const observer = new MutationObserver(sync);
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-media-ready",
        "data-pswp-src",
      ],
    });
    createEffect(() => {
      route();
      options.conversationId();
      options.ready();
      options.revision();
      untrack(sync);
    });
    onCleanup(() => {
      disposed = true;
      controller.abort();
      observer.disconnect();
      lightbox.shouldOpen = false;
      lightbox.destroy();
    });
  });
}
