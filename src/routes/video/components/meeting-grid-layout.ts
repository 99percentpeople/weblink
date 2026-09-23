import {
  batch,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  type Accessor,
} from "solid-js";

export interface MeetingGridLayout {
  count: number;
  columns: number;
  rows: number;
  tileWidth: number;
  tileHeight: number;
  gap: number;
  offsetX: number;
  offsetY: number;
}

const ASPECT_RATIO = 16 / 9;
// Keep the current arrangement through small changes around a column boundary.
const COLUMN_SWITCH_GAIN = 8;

export function calculateMeetingGridLayout(
  width: number,
  height: number,
  count: number,
  previous?: MeetingGridLayout,
): MeetingGridLayout {
  width = Math.max(0, Math.floor(width));
  height = Math.max(0, Math.floor(height));
  const gap = Math.min(
    width <= 600 ? 8 : 12,
    width / Math.max(1, count),
    height / Math.max(1, count),
  );
  const fit = (columns: number): MeetingGridLayout => {
    const rows = Math.max(1, Math.ceil(count / columns));
    const availableWidth = Math.min(
      (width - gap * (columns - 1)) / columns,
      ((height - gap * (rows - 1)) / rows) * ASPECT_RATIO,
    );
    // Round down to the browser's layout precision so tracks cannot overflow.
    const tileWidth = count
      ? Math.max(0, Math.floor(availableWidth * 64) / 64)
      : 0;
    const tileHeight = tileWidth / ASPECT_RATIO;
    return {
      count,
      columns,
      rows,
      tileWidth,
      tileHeight,
      gap,
      offsetX:
        (width -
          columns * tileWidth -
          (columns - 1) * gap) /
        2,
      offsetY:
        (height - rows * tileHeight - (rows - 1) * gap) / 2,
    };
  };
  let best = fit(1);
  for (let columns = 2; columns <= count; columns++) {
    const candidate = fit(columns);
    if (candidate.tileWidth > best.tileWidth)
      best = candidate;
  }
  if (previous?.count === count && previous.tileWidth > 0) {
    const current = fit(previous.columns);
    if (
      best.tileWidth - current.tileWidth <=
      COLUMN_SWITCH_GAIN
    )
      return current;
  }
  return best;
}

/** A single observer measures the allotted grid box, never its child tiles. */
export function createMeetingGridLayout(
  element: Accessor<HTMLElement | undefined>,
  count: Accessor<number>,
  transitionLayout: (update: () => void) => void = (
    update,
  ) => update(),
): Accessor<MeetingGridLayout> & {
  measure(): void;
  schedule(update: () => void): void;
} {
  const [size, setSize] = createSignal(
    { width: 0, height: 0 },
    {
      equals: (a, b) =>
        a.width === b.width && a.height === b.height,
    },
  );
  let frame: number | undefined;
  let frameWindow: Window | undefined;
  let pending = size();
  let pendingUpdate: (() => void) | undefined;
  let disposed = false;
  const scheduleFrame = () => {
    if (disposed || frame !== undefined) return;
    // PiP keeps rendering while the opener's animation frames are suspended.
    frameWindow =
      element()?.ownerDocument.defaultView ?? window;
    frame = frameWindow.requestAnimationFrame(() => {
      frame = undefined;
      if (disposed) return;
      const update = pendingUpdate;
      pendingUpdate = undefined;
      const apply = () =>
        batch(() => {
          update?.();
          setSize(pending);
        });
      // The first measurement (or a hidden stage) has no visible layout to tween.
      if (
        size().width > 0 &&
        size().height > 0 &&
        pending.width > 0 &&
        pending.height > 0
      )
        transitionLayout(apply);
      else apply();
    });
  };
  const measure = () => {
    const target = element();
    if (!target) return;
    // An explicit transition already measures synchronously. Consume its pending
    // resize, but keep any queued source update for the next shared frame.
    if (frame !== undefined && !pendingUpdate) {
      frameWindow?.cancelAnimationFrame(frame);
      frame = undefined;
    }
    pending = {
      width: target.clientWidth,
      height: target.clientHeight,
    };
    setSize(pending);
  };
  onMount(() => {
    const target = element();
    if (!target) return;
    const Observer =
      (
        target.ownerDocument.defaultView as
          | typeof window
          | null
      )?.ResizeObserver ?? ResizeObserver;
    const observer = new Observer((entries) => {
      if (disposed) return;
      const entry = entries.find(
        (entry) => entry.target === target,
      );
      if (!entry) return;
      pending = {
        width: Math.max(
          0,
          Math.floor(entry.contentRect.width),
        ),
        height: Math.max(
          0,
          Math.floor(entry.contentRect.height),
        ),
      };
      if (
        frame !== undefined ||
        (pending.width === size().width &&
          pending.height === size().height)
      )
        return;
      scheduleFrame();
    });
    observer.observe(target);
    onCleanup(() => observer.disconnect());
  });
  onCleanup(() => {
    disposed = true;
    pendingUpdate = undefined;
    if (frame !== undefined)
      frameWindow?.cancelAnimationFrame(frame);
  });
  const layout = createMemo<MeetingGridLayout>((previous) =>
    calculateMeetingGridLayout(
      size().width,
      size().height,
      count(),
      previous,
    ),
  );
  return Object.assign(layout, {
    measure,
    schedule(update: () => void) {
      pendingUpdate = update;
      scheduleFrame();
    },
  });
}
