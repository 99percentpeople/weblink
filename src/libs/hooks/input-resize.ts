import {
  Accessor,
  createEffect,
  onCleanup,
  onMount,
} from "solid-js";

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      textareaAutoResize?: {};
      inputAutoResize?: {};
    }
  }
}

export const textareaAutoResize = (
  el: HTMLTextAreaElement,
  signal?: Accessor<string>,
) => {
  const view = el.ownerDocument.defaultView;
  let frame: number | undefined;
  let observer: ResizeObserver | undefined;
  let width: number | undefined;
  const resizeTextarea = () => {
    el.style.height = "";
    // scrollHeight includes wrapped placeholder text, even while an entering
    // chat pane has zero width. Empty inputs should retain their native rows.
    if (!el.value || el.clientWidth === 0) return;
    const borderHeight = el.offsetHeight - el.clientHeight;
    el.style.height = el.scrollHeight + borderHeight + "px";
  };
  const scheduleResize = () => {
    if (frame !== undefined) return;
    if (!view?.requestAnimationFrame) {
      resizeTextarea();
      return;
    }
    frame = view.requestAnimationFrame(() => {
      frame = undefined;
      resizeTextarea();
    });
  };

  createEffect(() => {
    signal?.();
    scheduleResize();
  });

  onMount(() => {
    el.addEventListener("input", scheduleResize);
    el.addEventListener("change", scheduleResize);
    el.addEventListener("focus", scheduleResize);
    if (view?.ResizeObserver) {
      observer = new view.ResizeObserver(([entry]) => {
        if (!entry || entry.contentRect.width === width)
          return;
        width = entry.contentRect.width;
        // Only width changes affect wrapping. Defer writes out of the observer
        // callback and ignore the height changes produced by our own sizing.
        scheduleResize();
      });
      observer.observe(el);
    }
    scheduleResize();
  });

  onCleanup(() => {
    observer?.disconnect();
    if (frame !== undefined)
      view?.cancelAnimationFrame(frame);
    el.removeEventListener("input", scheduleResize);
    el.removeEventListener("change", scheduleResize);
    el.removeEventListener("focus", scheduleResize);
  });
};

export const inputAutoResize = (
  el: HTMLElement,
  signal?: Accessor<string>,
) => {
  const resizeInput = () => {
    el.style.width = "";
    const borderWidth = el.offsetWidth - el.clientWidth;
    el.style.width = el.scrollWidth + borderWidth + "px";
  };

  createEffect(() => {
    signal?.();
    resizeInput();
  });

  onMount(() => {
    el.addEventListener("input", resizeInput);
    el.addEventListener("change", resizeInput);
    el.addEventListener("focus", resizeInput);
    createEffect(() => setTimeout(() => resizeInput(), 10));
  });

  onCleanup(() => {
    el.removeEventListener("input", resizeInput);
    el.removeEventListener("change", resizeInput);
    el.removeEventListener("focus", resizeInput);
  });
};
