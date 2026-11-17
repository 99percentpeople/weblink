import { createSignal, onCleanup, onMount } from "solid-js";

type Point = { x: number; y: number };
type Gesture = {
  id: number;
  start: Point;
  last: Point;
  origin: Point;
  scale: Point;
};

/** Keep a draggable panel inside its mounted surface, including fullscreen and PiP. */
export function createFloatingPanel(options: {
  boundary(): HTMLElement;
  panel(): HTMLElement;
  handle(): HTMLElement;
}) {
  const initial = { x: 8, y: 40 };
  const [position, setPosition] = createSignal(initial);
  const [dragging, setDragging] = createSignal(false);

  onMount(() => {
    const boundary = options.boundary();
    const panel = options.panel();
    const handle = options.handle();
    const doc = panel.ownerDocument;
    const win = doc.defaultView!;
    const life = new AbortController();
    let preferred = initial;
    let gesture: Gesture | undefined;

    const readScale = (): Point | undefined => {
      const rect = boundary.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      return {
        x: boundary.clientWidth / rect.width,
        y: boundary.clientHeight / rect.height,
      };
    };
    const clamp = (point: Point): Point => ({
      x: Math.max(
        8,
        Math.min(
          point.x,
          boundary.clientWidth - panel.offsetWidth - 8,
        ),
      ),
      y: Math.max(
        8,
        Math.min(
          point.y,
          boundary.clientHeight - panel.offsetHeight - 8,
        ),
      ),
    });
    const release = () => {
      const previous = gesture;
      gesture = undefined;
      setDragging(false);
      if (
        previous &&
        handle.hasPointerCapture?.(previous.id)
      )
        handle.releasePointerCapture(previous.id);
    };
    const resize = () => {
      if (!boundary.clientWidth || !boundary.clientHeight) {
        release();
        return;
      }
      // Temporary keyboard/layout clamping must not overwrite the user's position.
      const next = clamp(preferred);
      setPosition(next);
      if (!gesture) return;
      const scale = readScale();
      if (!scale) {
        release();
        return;
      }
      // Live statistics can resize the panel mid-drag. Keep capture and rebase
      // at the last pointer so clamping does not leave movement stuck at an edge.
      gesture.start = gesture.last;
      gesture.origin = next;
      gesture.scale = scale;
    };
    const endDragAndResize = () => {
      release();
      resize();
    };
    const move = (point: Point) => {
      preferred = clamp(point);
      setPosition(preferred);
    };
    handle.addEventListener(
      "pointerdown",
      (event) => {
        if (
          gesture ||
          event.button !== 0 ||
          event.isPrimary === false
        )
          return;
        const scale = readScale();
        if (!scale) return;
        event.preventDefault();
        // Mouse users can continue with arrow keys; touch keeps an open IME.
        if (event.pointerType !== "touch")
          handle.focus({ preventScroll: true });
        const point = {
          x: event.clientX,
          y: event.clientY,
        };
        gesture = {
          id: event.pointerId,
          start: point,
          last: point,
          origin: position(),
          scale,
        };
        handle.setPointerCapture?.(event.pointerId);
        setDragging(true);
      },
      { signal: life.signal },
    );
    handle.addEventListener(
      "pointermove",
      (event) => {
        if (!gesture || gesture.id !== event.pointerId)
          return;
        event.preventDefault();
        gesture.last = {
          x: event.clientX,
          y: event.clientY,
        };
        move({
          x:
            gesture.origin.x +
            (event.clientX - gesture.start.x) *
              gesture.scale.x,
          y:
            gesture.origin.y +
            (event.clientY - gesture.start.y) *
              gesture.scale.y,
        });
      },
      { signal: life.signal },
    );
    for (const type of [
      "pointerup",
      "pointercancel",
      "lostpointercapture",
    ] as const)
      handle.addEventListener(
        type,
        (event) => {
          if (gesture?.id === event.pointerId) release();
        },
        { signal: life.signal },
      );
    handle.addEventListener(
      "keydown",
      (event) => {
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.isComposing
        )
          return;
        const step = event.shiftKey ? 24 : 8;
        const offset: Record<string, Point> = {
          ArrowLeft: { x: -step, y: 0 },
          ArrowRight: { x: step, y: 0 },
          ArrowUp: { x: 0, y: -step },
          ArrowDown: { x: 0, y: step },
        };
        if (event.key !== "Home" && !offset[event.key])
          return;
        event.preventDefault();
        release();
        if (event.key === "Home") {
          preferred = initial;
          resize();
        } else {
          const delta = offset[event.key];
          move({
            x: position().x + delta.x,
            y: position().y + delta.y,
          });
        }
      },
      { signal: life.signal },
    );
    const observer = new ResizeObserver(resize);
    observer.observe(boundary);
    observer.observe(panel);
    doc.addEventListener(
      "fullscreenchange",
      endDragAndResize,
      {
        signal: life.signal,
      },
    );
    doc.addEventListener("visibilitychange", release, {
      signal: life.signal,
    });
    win.addEventListener("resize", endDragAndResize, {
      signal: life.signal,
    });
    win.addEventListener("blur", release, {
      signal: life.signal,
    });
    win.visualViewport?.addEventListener(
      "resize",
      endDragAndResize,
      {
        signal: life.signal,
      },
    );
    resize();
    onCleanup(() => {
      life.abort();
      observer.disconnect();
      release();
    });
  });

  return { position, dragging };
}
