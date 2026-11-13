import {
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import type { ActionFanSpace } from "./meeting-action-fan";

type Point = { x: number; y: number };
type Edge = "left" | "right" | "top" | "bottom";
type Gesture = {
  id: number;
  target: HTMLElement;
  start: Point;
  origin: Point;
};

/** Keep the dock inside the video, including while IME changes its layout. */
export function createFloatingTileActions(options: {
  enabled?(): boolean;
  keyboardFocused?(): boolean;
  container(): HTMLElement;
  trigger(): HTMLElement | undefined;
  onActivate(): void;
  onDragStart(): void;
}) {
  const [dragging, setDragging] = createSignal(false);
  const [edge, setEdge] = createSignal<Edge>("right");
  const [opensRight, setOpensRight] = createSignal(false);
  const [below, setBelow] = createSignal(false);
  const [menuSize, setMenuSize] = createSignal<{
    width: number;
    height: number;
  }>();
  const [space, setSpace] = createSignal<ActionFanSpace>();

  onMount(() => {
    const element = options.container();
    const boundary = element.parentElement!;
    const doc = element.ownerDocument;
    const win = doc.defaultView!;
    const viewport = win.visualViewport;
    const life = new AbortController();
    let gesture: Gesture | undefined;
    let position: Point = { x: 0, y: 0 };
    let bounds = { width: 0, height: 0, x: 0, y: 0 };
    let fraction: Point = { x: 1, y: 1 };
    let keyboardAnchor: Point | undefined;
    let freePosition = false;
    let ready = false;
    let frame = 0;
    let suppressClick = false;

    const measure = () => {
      const width = boundary.clientWidth;
      const height = boundary.clientHeight;
      bounds = {
        width,
        height,
        x: Math.max(0, width - element.offsetWidth),
        y: Math.max(0, height - element.offsetHeight),
      };
      return width > 0 && height > 0;
    };
    const clamp = (point: Point): Point => ({
      x: Math.max(0, Math.min(bounds.x, point.x)),
      y: Math.max(0, Math.min(bounds.y, point.y)),
    });
    const visiblePosition = (): Point => {
      const rect = boundary.getBoundingClientRect();
      const current = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return position;
      return clamp({
        x:
          ((current.left - rect.left) / rect.width) *
          bounds.width,
        y:
          ((current.top - rect.top) / rect.height) *
          bounds.height,
      });
    };
    const paint = () => {
      frame = 0;
      if (freePosition) {
        Object.assign(element.style, {
          left: "0px",
          top: "0px",
          right: "auto",
          bottom: "auto",
          transform: `translate3d(${position.x}px, ${position.y}px, 0)`,
        });
        return;
      }
      // A docked handle belongs to a CSS edge, not a measured pixel coordinate.
      // This stays attached even before ResizeObserver catches up with IME layout.
      const offset = (axis: "x" | "y", size: number) =>
        keyboardAnchor
          ? `max(0px, min(${keyboardAnchor[axis]}px, calc(100% - ${size}px)))`
          : `max(0px, calc(${fraction[axis] * 100}% - ${fraction[axis] * size}px))`;
      const side = edge();
      const fixed = options.enabled?.() === false;
      Object.assign(element.style, {
        left:
          fixed || side === "right"
            ? "auto"
            : side === "left"
              ? "0px"
              : offset("x", element.offsetWidth),
        top:
          fixed || side === "bottom"
            ? "auto"
            : side === "top"
              ? "0px"
              : offset("y", element.offsetHeight),
        right: fixed || side === "right" ? "0px" : "auto",
        bottom: fixed || side === "bottom" ? "0px" : "auto",
        transform: "translate3d(0px, 0px, 0)",
      });
    };
    const flush = () => {
      win.cancelAnimationFrame(frame);
      paint();
    };
    const updateMenu = () => {
      setSpace({
        width: bounds.width,
        height: bounds.height,
        x: position.x,
        y: position.y,
        size: element.offsetWidth,
      });
      const opensBelow = position.y < bounds.y / 2;
      setOpensRight(position.x < bounds.x / 2);
      setBelow(opensBelow);
      setMenuSize({
        width: opensRight()
          ? bounds.width - position.x
          : position.x + element.offsetWidth,
        height: Math.max(
          0,
          (opensBelow
            ? bounds.y - position.y
            : position.y) - 4,
        ),
      });
    };
    const dock = () => {
      switch (edge()) {
        case "left":
          position.x = 0;
          break;
        case "right":
          position.x = bounds.x;
          break;
        case "top":
          position.y = 0;
          break;
        case "bottom":
          position.y = bounds.y;
          break;
      }
      position = clamp(position);
    };
    const release = () => {
      const previous = gesture;
      gesture = undefined;
      if (previous?.target.hasPointerCapture?.(previous.id))
        previous.target.releasePointerCapture(previous.id);
    };
    const settle = () => {
      if (!gesture) return;
      const moved = dragging();
      release();
      // Commit the last sample before enabling the snap transition.
      flush();
      const start = { ...position };
      setDragging(false);
      if (moved) {
        const distances: Record<Edge, number> = {
          left: position.x,
          right: bounds.x - position.x,
          top: position.y,
          bottom: bounds.y - position.y,
        };
        // Preserve the current edge when a corner is equally close to two edges.
        setEdge((current) =>
          (Object.keys(distances) as Edge[]).reduce(
            (nearest, candidate) =>
              distances[candidate] < distances[nearest]
                ? candidate
                : nearest,
            current,
          ),
        );
        fraction = {
          x: bounds.x ? position.x / bounds.x : fraction.x,
          y: bounds.y ? position.y / bounds.y : fraction.y,
        };
      }
      dock();
      if (moved && keyboardAnchor)
        keyboardAnchor = { ...position };
      freePosition = false;
      paint();
      // Animate only the remaining distance to the CSS dock. The final transform
      // is zero, so subsequent viewport/layout changes cannot retain stale offsets.
      element.style.transform = `translate3d(${start.x - position.x}px, ${start.y - position.y}px, 0)`;
      element.getBoundingClientRect();
      element.dataset.settling = "";
      element.style.transform = "translate3d(0px, 0px, 0)";
      updateMenu();
    };
    const resize = () => {
      if (!measure()) return;
      // A rotation/fullscreen change ends the old coordinate-space gesture.
      if (gesture) {
        suppressClick = true;
        release();
        setDragging(false);
      }
      delete element.dataset.settling;
      freePosition = false;
      if (options.enabled?.() === false) {
        position = { x: bounds.x, y: bounds.y };
      } else if (keyboardAnchor) {
        // Preserve the local offset along the chosen video edge, not a screen
        // coordinate or a fraction of each intermediate IME layout. The DOM
        // follows the video's translation; docking/clamping keeps it inside.
        position = { ...keyboardAnchor };
        dock();
      } else {
        // Temporary IME clamping must not overwrite the saved dock.
        position = {
          x: fraction.x * bounds.x,
          y: fraction.y * bounds.y,
        };
        dock();
      }
      flush();
      element.dataset.positioned = "";
      ready = true;
      updateMenu();
    };
    const isTrigger = (event: Event) => {
      const trigger = options.trigger();
      return (
        !!trigger && event.composedPath().includes(trigger)
      );
    };
    const down = (event: PointerEvent) => {
      if (!isTrigger(event)) return;
      // Wait for a completed click so the accessible trigger also serves as
      // a drag handle, without forwarding the gesture to the remote surface.
      event.stopPropagation();
      // Opening or dragging the dot must not dismiss IME halfway through the gesture.
      if (options.keyboardFocused?.())
        event.preventDefault();
      if (
        gesture ||
        event.button !== 0 ||
        event.isPrimary === false
      )
        return;
      suppressClick = false;
      if (options.enabled?.() === false) return;
      if (!ready) resize();
      if (!ready || !measure()) return;
      // Read the visible location when grabbing a still-settling button.
      const origin = visiblePosition();
      // Freeze an in-flight snap immediately, including a press-and-hold.
      delete element.dataset.settling;
      position = origin;
      freePosition = true;
      flush();
      gesture = {
        id: event.pointerId,
        target: options.trigger()!,
        start: { x: event.clientX, y: event.clientY },
        origin,
      };
      gesture.target.setPointerCapture?.(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId)
        return;
      event.stopPropagation();
      const dx = event.clientX - gesture.start.x;
      const dy = event.clientY - gesture.start.y;
      if (!dragging()) {
        if (Math.hypot(dx, dy) < 6) return;
        suppressClick = true;
        delete element.dataset.settling;
        setDragging(true);
        options.onDragStart();
      }
      event.preventDefault();
      const rect = boundary.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      position = clamp({
        x:
          gesture.origin.x +
          (dx / rect.width) * bounds.width,
        y:
          gesture.origin.y +
          (dy / rect.height) * bounds.height,
      });
      if (!frame) frame = win.requestAnimationFrame(paint);
    };
    const end = (event: PointerEvent) => {
      if (!gesture || gesture.id !== event.pointerId)
        return;
      event.stopPropagation();
      if (event.type === "pointerup") move(event);
      else suppressClick = true;
      settle();
    };
    const click = (event: MouseEvent) => {
      if (!isTrigger(event)) return;
      event.stopPropagation();
      // A keyboard/assistive click remains available even after cancellation.
      if (suppressClick && event.detail !== 0) {
        event.preventDefault();
        return;
      }
      options.onActivate();
    };
    const cancel = () => {
      if (!gesture) return;
      suppressClick = true;
      settle();
    };
    const capture = { capture: true, signal: life.signal };
    element.addEventListener("pointerdown", down, capture);
    element.addEventListener("click", click, capture);
    element.addEventListener(
      "contextmenu",
      (event) => {
        if (isTrigger(event)) event.preventDefault();
      },
      capture,
    );
    // Document listeners also handle capture loss and drags outside the tile.
    doc.addEventListener("pointermove", move, {
      ...capture,
      passive: false,
    });
    doc.addEventListener("pointerup", end, capture);
    doc.addEventListener("pointercancel", end, capture);
    element.addEventListener(
      "lostpointercapture",
      end,
      capture,
    );
    win.addEventListener("blur", cancel, {
      signal: life.signal,
    });
    doc.addEventListener(
      "visibilitychange",
      () => {
        if (doc.hidden) cancel();
      },
      { signal: life.signal },
    );
    win.addEventListener("resize", resize, {
      signal: life.signal,
    });
    win.addEventListener("scroll", resize, {
      capture: true,
      signal: life.signal,
    });
    viewport?.addEventListener("resize", resize, {
      signal: life.signal,
    });
    viewport?.addEventListener("scroll", resize, {
      signal: life.signal,
    });
    doc.addEventListener("fullscreenchange", resize, {
      signal: life.signal,
    });
    const observer = new ResizeObserver(resize);
    observer.observe(boundary);
    observer.observe(element);
    resize();
    createEffect(
      on(
        () =>
          [
            options.enabled?.() !== false,
            options.keyboardFocused?.() === true,
          ] as const,
        ([enabled, keyboardFocused]) => {
          const anchor = enabled && keyboardFocused;
          if (anchor && !keyboardAnchor) {
            // CSS may have followed a resize before its observer has run.
            // Capture the location currently visible to the user.
            keyboardAnchor = measure()
              ? visiblePosition()
              : { ...position };
          } else if (!anchor) keyboardAnchor = undefined;
          resize();
        },
      ),
    );
    onCleanup(() => {
      life.abort();
      observer.disconnect();
      win.cancelAnimationFrame(frame);
      release();
    });
  });

  return {
    dragging,
    edge,
    opensRight,
    below,
    menuSize,
    space,
  };
}
