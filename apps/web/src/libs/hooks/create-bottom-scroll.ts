import {
  type Accessor,
  createEffect,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js";

interface BottomScrollOptions {
  ready: Accessor<boolean>;
  revision: Accessor<unknown>;
  /** Changes only for newly appended messages, not history or layout updates. */
  appendRevision: Accessor<unknown>;
}

interface ScrollAnchor {
  element: HTMLElement;
  offset: number;
}

type ScrollMotion = "instant" | "smooth";

/** Owns one conversation's scrollport, not the document/router scroll. */
export function createBottomScroll(
  options: BottomScrollOptions,
) {
  const [viewport, setViewport] =
    createSignal<HTMLElement>();
  const [content, setContent] = createSignal<HTMLElement>();
  const [positioned, setPositioned] = createSignal(false);
  const [following, setFollowing] = createSignal(true);
  const reducedMotion = window.matchMedia?.(
    "(prefers-reduced-motion: reduce)",
  );
  let anchor: ScrollAnchor | undefined;
  let lastScrollTop = 0;
  let smoothTarget: number | undefined;
  let disposed = false;

  const maximum = (element: HTMLElement) =>
    Math.max(
      0,
      element.scrollHeight - element.clientHeight,
    );

  function captureAnchor() {
    const element = viewport();
    const list = content();
    anchor = undefined;
    if (!element || !list) return;

    const top = element.getBoundingClientRect().top;
    for (const item of list.querySelectorAll<HTMLElement>(
      "[data-chat-message]",
    )) {
      const rect = item.getBoundingClientRect();
      if (rect.bottom > top) {
        anchor = { element: item, offset: rect.top - top };
        break;
      }
    }
  }

  function moveTo(
    element: HTMLElement,
    top: number,
    motion: ScrollMotion = "instant",
  ) {
    const target = Math.max(
      0,
      Math.min(top, maximum(element)),
    );
    const distance = Math.abs(element.scrollTop - target);
    const smooth =
      motion === "smooth" &&
      positioned() &&
      !reducedMotion?.matches &&
      distance > 0.5;

    if (smooth) {
      // Reissuing the same native smooth scroll restarts it. Resize/scroll
      // events may update the destination, but must not finish it instantly.
      if (smoothTarget === target) return;
      smoothTarget = target;
      element.scrollTo({ top: target, behavior: "smooth" });
      // Browsers may ignore smooth motion, including for accessibility.
      if (Math.abs(element.scrollTop - target) <= 0.5) {
        smoothTarget = undefined;
      }
    } else {
      const wasAnimating = smoothTarget !== undefined;
      smoothTarget = undefined;
      if (wasAnimating || distance > 0.5) {
        element.scrollTo({
          top: target,
          behavior: "instant",
        });
      }
    }
    // Record our own write before the browser delivers its scroll event.
    lastScrollTop = element.scrollTop;
  }

  function synchronize(motion: ScrollMotion = "instant") {
    const element = viewport();
    if (
      disposed ||
      !options.ready() ||
      !element?.isConnected ||
      !content()?.isConnected ||
      element.clientHeight === 0
    ) {
      return;
    }

    if (following()) {
      moveTo(
        element,
        maximum(element),
        smoothTarget !== undefined ? "smooth" : motion,
      );
    } else if (anchor?.element.isConnected) {
      const offset =
        anchor.element.getBoundingClientRect().top -
        element.getBoundingClientRect().top;
      moveTo(
        element,
        element.scrollTop + offset - anchor.offset,
      );
    } else {
      lastScrollTop = element.scrollTop;
    }

    if (smoothTarget === undefined) captureAnchor();
    // Initial positioning is always instant, before the history is revealed.
    setPositioned(true);
  }

  function interrupt() {
    const element = viewport();
    if (!element || smoothTarget === undefined) return;
    setFollowing(false);
    moveTo(element, element.scrollTop);
    captureAnchor();
  }

  createEffect(
    on([viewport, content], ([element, list]) => {
      if (!element || !list) return;
      const current = () =>
        !disposed &&
        viewport() === element &&
        content() === list;
      const onScroll = () => {
        if (!current() || !positioned()) return;
        const max = maximum(element);
        // Resizing can clamp scrollTop without the reader scrolling up.
        const previous = Math.min(lastScrollTop, max);
        if (element.scrollTop < previous - 1) {
          interrupt();
          setFollowing(false);
        }
        lastScrollTop = element.scrollTop;

        if (smoothTarget !== undefined) {
          if (Math.abs(max - element.scrollTop) <= 0.5) {
            smoothTarget = undefined;
            captureAnchor();
          } else if (smoothTarget !== max) {
            synchronize("smooth");
          }
          // Intermediate animation positions are not reader scrolls and must
          // not trigger the instant layout-following path below.
          return;
        }

        if (max - element.scrollTop <= 2) {
          setFollowing(true);
        }
        if (following()) synchronize();
        else captureAnchor();
      };
      const onWheel = (event: WheelEvent) => {
        if (event.deltaY !== 0) interrupt();
      };
      const onKeyDown = (event: KeyboardEvent) => {
        const target = event.target;
        if (
          event.defaultPrevented ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          (target instanceof HTMLElement &&
            (target.isContentEditable ||
              target.closest("input, textarea, select")))
        ) {
          return;
        }
        if (
          [
            "ArrowUp",
            "ArrowDown",
            "PageUp",
            "PageDown",
            "Home",
            "End",
            " ",
          ].includes(event.key)
        ) {
          interrupt();
        }
      };
      const onMotionChange = () => {
        if (!current() || !reducedMotion?.matches) return;
        smoothTarget = undefined;
        untrack(synchronize);
      };
      const observer = new ResizeObserver(() => {
        if (current()) untrack(synchronize);
      });
      // Layout events drive correction; native scrolling drives animation.
      // No timers, animation-frame loops or delayed scroll retries.
      observer.observe(list);
      observer.observe(element);
      element.addEventListener("scroll", onScroll, {
        passive: true,
      });
      element.addEventListener("wheel", onWheel, {
        passive: true,
      });
      element.addEventListener("pointerdown", interrupt, {
        passive: true,
      });
      element.addEventListener("touchstart", interrupt, {
        passive: true,
      });
      element.addEventListener("keydown", onKeyDown);
      reducedMotion?.addEventListener(
        "change",
        onMotionChange,
      );
      synchronize();
      onCleanup(() => {
        observer.disconnect();
        element.removeEventListener("scroll", onScroll);
        element.removeEventListener("wheel", onWheel);
        element.removeEventListener(
          "pointerdown",
          interrupt,
        );
        element.removeEventListener(
          "touchstart",
          interrupt,
        );
        element.removeEventListener("keydown", onKeyDown);
        reducedMotion?.removeEventListener(
          "change",
          onMotionChange,
        );
        if (smoothTarget !== undefined) {
          moveTo(element, element.scrollTop);
        }
      });
    }),
  );

  createEffect(
    on(
      [
        options.ready,
        options.revision,
        options.appendRevision,
      ],
      ([ready, , appended], previous) => {
        if (!ready) {
          const element = viewport();
          if (element && smoothTarget !== undefined) {
            moveTo(element, element.scrollTop);
          }
          setPositioned(false);
          setFollowing(true);
          anchor = undefined;
          return;
        }
        // Solid has committed the message DOM before user effects run.
        synchronize(
          previous?.[0] && appended !== previous[2]
            ? "smooth"
            : "instant",
        );
      },
    ),
  );

  onCleanup(() => {
    disposed = true;
    anchor = undefined;
  });

  return {
    viewport,
    viewportRef: setViewport,
    contentRef: setContent,
    positioned,
    following,
    toElement(target: HTMLElement) {
      const element = viewport();
      if (!element || !element.contains(target)) return;
      const bounds = element.getBoundingClientRect();
      const rect = target.getBoundingClientRect();
      if (
        rect.top >= bounds.top &&
        rect.bottom <= bounds.bottom
      )
        return;
      interrupt();
      setFollowing(false);
      moveTo(
        element,
        element.scrollTop +
          rect.top -
          bounds.top -
          (element.clientHeight - rect.height) / 2,
      );
      captureAnchor();
    },
    toBottom() {
      setFollowing(true);
      anchor = undefined;
      untrack(() => synchronize("smooth"));
    },
    preservePosition(update: () => void) {
      interrupt();
      setFollowing(false);
      untrack(captureAnchor);
      untrack(update);
      untrack(synchronize);
    },
  };
}
