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

/** Keep movement local to the video, including a fullscreen or PiP document. */
export function createFloatingTileActions(options: {
  enabled?(): boolean;
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
    const life = new AbortController();
    let gesture: Gesture | undefined;
    let position: Point = { x: 0, y: 0 };
    let bounds = { width: 0, height: 0, x: 0, y: 0 };
    let fraction: Point = { x: 1, y: 1 };
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
    const paint = () => {
      frame = 0;
      element.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
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
      element.getBoundingClientRect();
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
      element.dataset.settling = "";
      dock();
      paint();
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
      if (options.enabled?.() === false) {
        position = { x: bounds.x, y: bounds.y };
      } else {
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
      const rect = boundary.getBoundingClientRect();
      const current = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      // Read the visible location when grabbing a still-settling button.
      const origin = clamp({
        x:
          ((current.left - rect.left) / rect.width) *
          bounds.width,
        y:
          ((current.top - rect.top) / rect.height) *
          bounds.height,
      });
      // Freeze an in-flight snap immediately, including a press-and-hold.
      delete element.dataset.settling;
      position = origin;
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
    doc.addEventListener("fullscreenchange", resize, {
      signal: life.signal,
    });
    const observer = new ResizeObserver(resize);
    observer.observe(boundary);
    observer.observe(element);
    resize();
    createEffect(
      on(() => options.enabled?.() !== false, resize, {
        defer: true,
      }),
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
