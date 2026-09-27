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
import type {
  createMotionLayoutRegistry,
  MotionLayoutNode,
} from "./motion-layout-registry";

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
  present: boolean;
  container?: HTMLElement;
  children: Map<
    string,
    {
      element: HTMLElement;
      rect: DOMRect;
      overlay: boolean;
    }
  >;
};
function measure(
  element: HTMLElement,
  children: readonly MotionLayoutNode[] = [],
  present = true,
): Box {
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
    present,
    children: new Map(
      children.map((child) => [
        child.options().layoutOverlay ??
          child.options().layoutSize!,
        {
          element: child.element,
          rect: child.element.getBoundingClientRect(),
          overlay:
            child.options().layoutOverlay !== undefined,
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
  registry: ReturnType<typeof createMotionLayoutRegistry>,
  options: {
    root?: Accessor<HTMLElement | undefined>;
    afterUpdate?: () => void;
  } = {},
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

  return (update) =>
    untrack(() => {
      const root = options.root?.();
      if ((options.root && !root) || reduced()) {
        finish();
        batch(update);
        batch(() => options.afterUpdate?.());
        return;
      }
      const nodes = () =>
        [...registry.nodes].filter(
          (node) => node.element.isConnected,
        );
      const key = (node: MotionLayoutNode) =>
        node.options().layoutId ?? node.key;
      const views = () =>
        nodes().filter(
          (node) => node.options().layout === true,
        );
      // Portal changes DOM hosts without changing Solid owners. Resolve physical
      // containment among registered nodes, never by scanning their descendants.
      const inside = (
        element: HTMLElement,
        candidates: readonly MotionLayoutNode[],
      ) =>
        candidates.filter(
          (node) =>
            node.element !== element &&
            element.contains(node.element),
        );
      const containers = () =>
        nodes().filter(
          (node) => node.options().layoutContainer,
        );
      const snapshot = () => {
        const currentContainers = containers();
        const corrections = nodes().filter(
          (node) =>
            node.options().layoutSize !== undefined ||
            node.options().layoutOverlay !== undefined,
        );
        return new Map(
          views().map((node) => [
            key(node),
            {
              ...measure(
                node.element,
                inside(node.element, corrections),
                node.present(),
              ),
              container: currentContainers
                .filter((container) =>
                  container.element.contains(node.element),
                )
                .reduce<HTMLElement | undefined>(
                  (closest, container) => {
                    if (
                      !closest ||
                      closest.contains(container.element)
                    )
                      return container.element;
                    return closest;
                  },
                  undefined,
                ),
            },
          ]),
        );
      };
      // Panels animate their actual height so chat text and controls are never scaled.
      const heights = () => {
        const current = nodes();
        const scrollports = current.filter(
          (node) => node.options().layoutScroll,
        );
        return new Map(
          current
            .filter(
              (node) => node.options().layout === "height",
            )
            .map((node) => [
              key(node),
              {
                element: node.element,
                height:
                  node.element.getBoundingClientRect()
                    .height,
                scroll: inside(
                  node.element,
                  scrollports,
                ).map(({ element: viewport }) => ({
                  viewport,
                  left: viewport.scrollLeft,
                  top: viewport.scrollTop,
                })),
              },
            ]),
        );
      };
      // The visible frame must be read before canceling an interrupted animation.
      const before = snapshot();
      const previousHeights = heights();
      finish();
      const previousContainers = new Map(
        containers().map((node) => [
          key(node),
          {
            ...measure(node.element),
            left: node.element.scrollLeft,
            top: node.element.scrollTop,
          },
        ]),
      );
      batch(update);
      batch(() => options.afterUpdate?.());
      const after = snapshot();
      // Keep ordinary list updates in flow: lifting every child out of a
      // scrollport collapses its scroll range and resets the scrollbar. Only
      // containers with views crossing a boundary need the fixed-box path.
      const flowContainers = new Set(
        containers()
          .filter(
            (node) =>
              previousContainers.get(key(node))?.visible &&
              measure(node.element).visible,
          )
          .map((node) => node.element),
      );
      for (const [id, end] of after) {
        const start = before.get(id);
        if (!end.present || !start?.visible || !end.visible)
          continue;
        if (start.container !== end.container) {
          if (start.container)
            flowContainers.delete(start.container);
          if (end.container)
            flowContainers.delete(end.container);
        }
      }
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
        // Measuring the destination can clamp a nested scrollport before WAAPI
        // reinstates the starting height. Undo that measurement side effect now,
        // before its scroll event can be mistaken for the reader scrolling up.
        for (const {
          viewport,
          left,
          top,
        } of previous.scroll) {
          if (!viewport.isConnected) continue;
          if (viewport.scrollLeft !== left)
            viewport.scrollLeft = left;
          if (viewport.scrollTop !== top)
            viewport.scrollTop = top;
        }
      }

      for (const node of containers()) {
        const element = node.element;
        if (flowContainers.has(element)) continue;
        const previous = previousContainers.get(key(node));
        const next = measure(element);
        const left = previous?.left ?? element.scrollLeft;
        const top = previous?.top ?? element.scrollTop;
        // Keep a collapsing rail paintable, outside the grid flow, until exit ends.
        const leavingViews = inside(element, views()).some(
          (view) => before.get(key(view))?.visible,
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
              previous?.display &&
              previous.display !== "none"
                ? previous.display
                : "block",
            position: "absolute",
            left: "0px",
            top: "0px",
            width: `${previous?.rect.width || (root ?? element.parentElement ?? element).clientWidth}px`,
            height: `${previous?.rect.height || (root ?? element.parentElement ?? element).clientHeight}px`,
          });
        }
        const wasActive = element.classList.contains(
          "motion-layout-active",
        );
        element.classList.add("motion-layout-active");
        restore.push(() =>
          element.classList.toggle(
            "motion-layout-active",
            wasActive,
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
        inFlow: boolean;
      }[] = [];
      for (const [id, end] of after) {
        // Presence owns leaving views. Still snapshot them above so an interrupted
        // exit can resume from the visible frame instead of fading in from zero.
        if (!end.present) continue;
        const start = before.get(id) ?? {
          ...end,
          opacity: 0,
          visible: false,
        };
        if (!start.visible && !end.visible) continue;
        entries.push({
          element: end.element,
          start,
          end,
          inFlow:
            !!end.container &&
            flowContainers.has(end.container),
        });
      }
      // Freeze views that cross layout boundaries at their destination size.
      // Stable scrollport children stay in flow and continue to scroll naturally.
      for (const {
        element,
        start,
        end,
        inFlow,
      } of entries) {
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
        if (!inFlow)
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
          });
        element.style.transformOrigin = "0 0";
      }
      const origins = entries.map(({ element }) =>
        element.getBoundingClientRect(),
      );
      for (const [
        index,
        { element, start, end, inFlow },
      ] of entries.entries()) {
        const rect = end.visible ? end.rect : start.rect;
        // Containment can make a fixed box relative to a frame instead of the
        // viewport. Measure that origin rather than assuming a parent offset.
        const origin = origins[index];
        if (!inFlow) {
          element.style.left = `${rect.left - origin.left}px`;
          element.style.top = `${rect.top - origin.top}px`;
        }
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
                  ? [
                      "width",
                      "transform",
                      "transform-origin",
                    ]
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
                  (1 - from.height / rect.height) *
                    progress;
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
                {
                  duration: 0.28,
                  ease: [0.22, 1, 0.36, 1],
                },
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
    });
}
