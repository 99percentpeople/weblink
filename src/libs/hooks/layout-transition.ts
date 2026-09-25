import {
  batch,
  createEffect,
  createSignal,
  on,
  onCleanup,
  untrack,
  type Accessor,
} from "solid-js";
import { animate } from "motion/mini";
import type { AnimationPlaybackControls } from "motion";
import { createReducedMotion } from "./reduced-motion";

/** Commit shared state outside Solid's effect batch so layout reads see updated DOM. */
export function createLayoutValue<T>(
  source: Accessor<T>,
  transition: (update: () => void) => void,
): Accessor<T> {
  const [displayed, setDisplayed] = createSignal(
    untrack(source),
  );
  let version = 0;
  createEffect(
    on(
      source,
      (next) => {
        const pending = ++version;
        // Microtasks also run when the opener's animation frames are suspended by PiP.
        queueMicrotask(() => {
          if (
            pending !== version ||
            Object.is(untrack(displayed), next)
          )
            return;
          transition(() => setDisplayed(() => next));
        });
      },
      { defer: true },
    ),
  );
  onCleanup(() => {
    version++;
  });
  return displayed;
}

type Box = {
  element: HTMLElement;
  rect: DOMRect;
  opacity: number;
  display: string;
  visible: boolean;
  children: Map<
    string,
    {
      element: HTMLElement;
      rect: DOMRect;
      overlay: boolean;
    }
  >;
};
function measure(element: HTMLElement): Box {
  const rect = element.getBoundingClientRect();
  const style = (
    element.ownerDocument.defaultView ?? window
  ).getComputedStyle(element);
  return {
    element,
    rect,
    opacity: Number(style.opacity),
    display: style.display,
    visible: rect.width > 0 && rect.height > 0,
    children: new Map(
      [
        ...element.querySelectorAll<HTMLElement>(
          "[data-motion-layout-size], [data-motion-layout-overlay]",
        ),
      ].map((child) => [
        child.dataset.motionLayoutOverlay ??
          child.dataset.motionLayoutSize!,
        {
          element: child,
          rect: child.getBoundingClientRect(),
          overlay: child.hasAttribute(
            "data-motion-layout-overlay",
          ),
        },
      ]),
    ),
  };
}
function saveStyles(
  element: HTMLElement,
  properties: string[],
) {
  const values = properties.map((property) => [
    property,
    element.style.getPropertyValue(property),
    element.style.getPropertyPriority(property),
  ]);
  return () => {
    for (const [property, value, priority] of values) {
      if (value)
        element.style.setProperty(
          property,
          value,
          priority,
        );
      else element.style.removeProperty(property);
    }
  };
}

/** Explicit before/after measurement, animated by Motion's native JS engine. */
export function createLayoutTransition(
  scope: Accessor<HTMLElement | undefined>,
  selector = "[data-motion-layout]",
  afterUpdate?: () => void,
): (update: () => void) => void {
  const reduced = createReducedMotion();
  let cleanup: (() => void) | undefined;
  const finish = () => {
    const current = cleanup;
    cleanup = undefined;
    current?.();
  };
  createEffect(() => {
    if (reduced()) finish();
  });
  onCleanup(finish);

  return (update) => {
    const root = scope();
    if (!root || reduced()) {
      finish();
      batch(update);
      batch(() => afterUpdate?.());
      return;
    }
    const snapshot = () =>
      new Map(
        [
          ...root.querySelectorAll<HTMLElement>(selector),
        ].map((element) => [
          element.dataset.motionLayout!,
          measure(element),
        ]),
      );
    // Panels animate their actual height so chat text and controls are never scaled.
    const heights = () =>
      new Map(
        [
          ...root.querySelectorAll<HTMLElement>(
            "[data-motion-layout-height]",
          ),
        ].map((element) => [
          element.dataset.motionLayoutHeight!,
          {
            element,
            height: element.getBoundingClientRect().height,
          },
        ]),
      );
    // The visible frame must be read before canceling an interrupted animation.
    const before = snapshot();
    const previousHeights = heights();
    finish();
    const containers = [
      ...root.querySelectorAll<HTMLElement>(
        "[data-motion-layout-container]",
      ),
    ];
    const previousContainers = new Map(
      containers.map((element) => [
        element.dataset.motionLayoutContainer!,
        {
          ...measure(element),
          left: element.scrollLeft,
          top: element.scrollTop,
        },
      ]),
    );
    batch(update);
    batch(() => afterUpdate?.());
    const after = snapshot();
    const restore: (() => void)[] = [];
    const animations: AnimationPlaybackControls[] = [];
    const scroll: (() => void)[] = [];

    for (const [id, next] of heights()) {
      const previous = previousHeights.get(id);
      if (!previous || previous.height === next.height)
        continue;
      restore.push(saveStyles(next.element, ["height"]));
      animations.push(
        animate(
          next.element,
          {
            height: [previous.height, next.height],
          },
          { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
        ),
      );
    }

    for (const element of root.querySelectorAll<HTMLElement>(
      "[data-motion-layout-container]",
    )) {
      const previous = previousContainers.get(
        element.dataset.motionLayoutContainer!,
      );
      const next = measure(element);
      const left = previous?.left ?? element.scrollLeft;
      const top = previous?.top ?? element.scrollTop;
      // Keep a collapsing rail paintable, outside the grid flow, until exit ends.
      const leavingViews = [
        ...element.querySelectorAll<HTMLElement>(selector),
      ].some(
        (view) =>
          before.get(view.dataset.motionLayout!)?.visible,
      );
      if (
        !next.visible &&
        (previous?.visible || leavingViews)
      ) {
        restore.push(
          saveStyles(element, [
            "display",
            "position",
            "width",
            "height",
            "left",
            "top",
          ]),
        );
        Object.assign(element.style, {
          display:
            previous?.display && previous.display !== "none"
              ? previous.display
              : "block",
          position: "absolute",
          left: "0px",
          top: "0px",
          width: `${previous?.rect.width || root.clientWidth}px`,
          height: `${previous?.rect.height || root.clientHeight}px`,
        });
      }
      element.setAttribute("data-motion-layout-active", "");
      restore.push(() =>
        element.removeAttribute(
          "data-motion-layout-active",
        ),
      );
      scroll.push(() => {
        element.scrollLeft = left;
        element.scrollTop = top;
      });
    }

    const entries: {
      element: HTMLElement;
      start: Box;
      end: Box;
    }[] = [];
    for (const [id, end] of after) {
      // Presence owns leaving views. Still snapshot them above so an interrupted
      // exit can resume from the visible frame instead of fading in from zero.
      if (
        end.element.hasAttribute(
          "data-motion-layout-exiting",
        )
      )
        continue;
      const start = before.get(id) ?? {
        ...end,
        opacity: 0,
        visible: false,
      };
      if (!start.visible && !end.visible) continue;
      entries.push({ element: end.element, start, end });
    }
    // Freeze every view at its destination size. Flow, clipping, and portal
    // reparenting must not change the coordinate system during a transition.
    for (const { element, start, end } of entries) {
      const rect = end.visible ? end.rect : start.rect;
      restore.push(
        saveStyles(element, [
          "position",
          "width",
          "height",
          "left",
          "top",
          "right",
          "bottom",
          "margin",
          "transform",
          "transform-origin",
          "opacity",
        ]),
      );
      Object.assign(element.style, {
        position: "fixed",
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        left: "0px",
        top: "0px",
        right: "auto",
        bottom: "auto",
        margin: "0px",
        transform: "none",
        transformOrigin: "0 0",
      });
    }
    const origins = entries.map(({ element }) =>
      element.getBoundingClientRect(),
    );
    for (const [
      index,
      { element, start, end },
    ] of entries.entries()) {
      const rect = end.visible ? end.rect : start.rect;
      // Containment can make a fixed box relative to a frame instead of the
      // viewport. Measure that origin rather than assuming a parent offset.
      const origin = origins[index];
      element.style.left = `${rect.left - origin.left}px`;
      element.style.top = `${rect.top - origin.top}px`;
      const from = start.visible ? start.rect : rect;
      const transform = `translate(${from.left - rect.left}px, ${from.top - rect.top}px) scale(${from.width / rect.width}, ${from.height / rect.height})`;
      element.style.transform = transform;
      element.style.opacity = String(
        start.visible ? start.opacity : 0,
      );
      animations.push(
        animate(
          element,
          {
            transform: [
              transform,
              "translate(0px, 0px) scale(1, 1)",
            ],
            opacity: [
              start.visible ? start.opacity : 0,
              end.visible ? end.opacity : 0,
            ],
          },
          { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
        ),
      );
      // Avatars interpolate their own size. Overlays retain their typography
      // and insets, with only their available width following the moving frame.
      if (start.visible && end.visible) {
        for (const [id, child] of end.children) {
          const old = start.children.get(id);
          if (
            !old ||
            !child.rect.width ||
            !child.rect.height
          )
            continue;
          restore.push(
            saveStyles(
              child.element,
              child.overlay
                ? ["width", "transform", "transform-origin"]
                : ["scale"],
            ),
          );
          const steps = child.overlay ? 64 : 32;
          const frames = Array.from(
            { length: steps + 1 },
            (_, i) => {
              const progress = i / steps;
              const parentX =
                from.width / rect.width +
                (1 - from.width / rect.width) * progress;
              const parentY =
                from.height / rect.height +
                (1 - from.height / rect.height) * progress;
              if (child.overlay) {
                const left = child.rect.left - rect.left;
                const top = child.rect.top - rect.top;
                const oldLeft = old.rect.left - from.left;
                const oldTop = old.rect.top - from.top;
                const x =
                  oldLeft + (left - oldLeft) * progress;
                const y =
                  oldTop + (top - oldTop) * progress;
                return `translate(${x / parentX - left}px, ${y / parentY - top}px) scale(${1 / parentX}, ${1 / parentY})`;
              }
              const width =
                old.rect.width +
                (child.rect.width - old.rect.width) *
                  progress;
              const height =
                old.rect.height +
                (child.rect.height - old.rect.height) *
                  progress;
              return `${width / child.rect.width / parentX} ${height / child.rect.height / parentY}`;
            },
          );
          if (child.overlay) {
            child.element.style.transformOrigin = "0 0";
            child.element.style.transform = frames[0];
            child.element.style.width = `${old.rect.width}px`;
          } else child.element.style.scale = frames[0];
          animations.push(
            animate(
              child.element,
              child.overlay
                ? {
                    transform: frames,
                    width: [
                      old.rect.width,
                      child.rect.width,
                    ],
                  }
                : { scale: frames },
              { duration: 0.28, ease: [0.22, 1, 0.36, 1] },
            ),
          );
        }
      }
    }
    const release = () => {
      for (const animation of animations)
        animation.cancel();
      for (const reset of restore.reverse()) reset();
      for (const reset of scroll) reset();
    };
    cleanup = release;
    if (!animations.length) finish();
    else
      void Promise.allSettled(
        animations.map((animation) => animation.finished),
      ).then(() => {
        if (cleanup === release) finish();
      });
  };
}
