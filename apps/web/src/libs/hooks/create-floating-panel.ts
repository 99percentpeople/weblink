import { createSignal, onCleanup, onMount } from "solid-js";

type Point = { x: number; y: number };
type Gesture = {
  id: number;
  start: Point;
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
      release();
      if (!boundary.clientWidth || !boundary.clientHeight)
        return;
      // Temporary keyboard/layout clamping must not overwrite the user's position.
      setPosition(clamp(preferred));
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
        const rect = boundary.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        event.preventDefault();
        // Mouse users can continue with arrow keys; touch keeps an open IME.
        if (event.pointerType !== "touch")
          handle.focus({ preventScroll: true });
        gesture = {
          id: event.pointerId,
          start: { x: event.clientX, y: event.clientY },
          origin: position(),
          scale: {
            x: boundary.clientWidth / rect.width,
            y: boundary.clientHeight / rect.height,
          },
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
    doc.addEventListener("fullscreenchange", resize, {
      signal: life.signal,
    });
    doc.addEventListener("visibilitychange", release, {
      signal: life.signal,
    });
    win.addEventListener("resize", resize, {
      signal: life.signal,
    });
    win.addEventListener("blur", release, {
      signal: life.signal,
    });
    win.visualViewport?.addEventListener("resize", resize, {
      signal: life.signal,
    });
    resize();
    onCleanup(() => {
      life.abort();
      observer.disconnect();
      release();
    });
  });

  return { position, dragging };
}
