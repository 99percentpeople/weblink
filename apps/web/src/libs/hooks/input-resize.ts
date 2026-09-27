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

// Copy resolved text metrics: the measuring textarea lives outside the editor
// and must not depend on its ancestor styles or change the surrounding layout.
const textareaSizingProperties = [
  "boxSizing",
  "width",
  "fontFamily",
  "fontSize",
  "fontStyle",
  "fontWeight",
  "fontStretch",
  "fontVariant",
  "fontFeatureSettings",
  "fontVariationSettings",
  "lineHeight",
  "letterSpacing",
  "wordSpacing",
  "textIndent",
  "textTransform",
  "textRendering",
  "tabSize",
  "direction",
  "whiteSpace",
  "wordBreak",
  "overflowWrap",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
] as const;

export const textareaAutoResize = (
  el: HTMLTextAreaElement,
  signal?: Accessor<string>,
) => {
  let view = el.ownerDocument.defaultView;
  let initialHeight = el.style.height;
  let frame: number | undefined;
  let observer: ResizeObserver | undefined;
  let width: number | undefined;
  let measurement: HTMLTextAreaElement | undefined;
  const resizeTextarea = () => {
    if (!view || !el.isConnected || el.clientWidth === 0)
      return;
    // Empty inputs retain their native rows, not wrapped placeholder height.
    if (!el.value) {
      if (el.style.height !== initialHeight)
        el.style.height = initialHeight;
      return;
    }
    if (!measurement) {
      measurement =
        el.ownerDocument.createElement("textarea");
      measurement.tabIndex = -1;
      measurement.setAttribute("aria-hidden", "true");
      measurement.style.cssText =
        "position:fixed;top:0;left:0;display:block;visibility:hidden;" +
        "pointer-events:none;overflow:hidden;resize:none;height:auto;" +
        "min-height:0;max-height:none;min-width:0;max-width:none;margin:0;";
      el.ownerDocument.body.append(measurement);
    }
    const style = view.getComputedStyle(el);
    for (const property of textareaSizingProperties)
      measurement.style[property] = style[property];
    measurement.rows = el.rows;
    measurement.wrap = el.wrap;
    measurement.value = el.value;
    const padding =
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom);
    const border =
      parseFloat(style.borderTopWidth) +
      parseFloat(style.borderBottomWidth);
    const height =
      measurement.scrollHeight +
      (style.boxSizing === "border-box"
        ? border
        : -padding);
    const nextHeight = `${height}px`;
    // Never collapse the live textarea to measure it: that intermediate layout
    // expands the chat viewport and clamps scrollTop, even if the final height
    // is unchanged (so ResizeObserver cannot detect the lost scroll position).
    if (el.style.height !== nextHeight)
      el.style.height = nextHeight;
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
    // Template-created nodes can belong to an inert document until mounted.
    view = el.ownerDocument.defaultView;
    initialHeight = el.style.height;
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
    measurement?.remove();
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
