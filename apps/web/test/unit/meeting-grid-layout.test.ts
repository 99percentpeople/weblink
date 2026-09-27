// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot, createSignal } from "solid-js";
import {
  calculateMeetingGridLayout,
  createMeetingGridLayout,
} from "@/routes/home/components/meeting-grid-layout";

describe("meeting grid geometry", () => {
  it("fits a wide short stage in one row and a narrow tall stage in multiple rows", () => {
    const wide = calculateMeetingGridLayout(1200, 200, 4);
    expect([wide.columns, wide.rows]).toEqual([4, 1]);
    const tall = calculateMeetingGridLayout(320, 720, 4);
    expect([tall.columns, tall.rows]).toEqual([1, 4]);
    const square = calculateMeetingGridLayout(800, 600, 4);
    expect([square.columns, square.rows]).toEqual([2, 2]);
    const solo = calculateMeetingGridLayout(1300, 180, 1);
    expect(solo.tileWidth).toBe(320);
    expect(solo.tileHeight).toBe(180);
  });

  it("contains every 16:9 tile in both dimensions for different source counts and stage sizes", () => {
    for (const count of [1, 2, 4, 7, 16, 40]) {
      for (const [width, height] of [
        [280, 150],
        [300, 650],
        [780, 180],
        [1400, 730],
      ]) {
        const layout = calculateMeetingGridLayout(
          width,
          height,
          count,
        );
        expect(
          layout.columns * layout.rows,
        ).toBeGreaterThanOrEqual(count);
        expect(layout.tileWidth).toBeGreaterThan(0);
        expect(
          layout.tileWidth / layout.tileHeight,
        ).toBeCloseTo(16 / 9);
        expect(
          layout.columns * layout.tileWidth +
            (layout.columns - 1) * layout.gap,
        ).toBeLessThanOrEqual(width);
        expect(
          layout.rows * layout.tileHeight +
            (layout.rows - 1) * layout.gap,
        ).toBeLessThanOrEqual(height);
      }
    }
  });

  it("resists boundary jitter in both directions but changes rows after a meaningful resize", () => {
    let layout = calculateMeetingGridLayout(1000, 281, 4);
    expect(layout.columns).toBe(4);
    expect(
      calculateMeetingGridLayout(1000, 285, 4).columns,
    ).toBe(2);
    for (const height of [284, 282, 285, 281, 284, 285]) {
      layout = calculateMeetingGridLayout(
        1000,
        height,
        4,
        layout,
      );
      expect(layout.columns).toBe(4);
    }
    layout = calculateMeetingGridLayout(
      1000,
      330,
      4,
      layout,
    );
    expect(layout.columns).toBe(2);
    for (const height of [283, 281, 285, 282]) {
      layout = calculateMeetingGridLayout(
        1000,
        height,
        4,
        layout,
      );
      expect(layout.columns).toBe(2);
    }
    layout = calculateMeetingGridLayout(
      1000,
      210,
      4,
      layout,
    );
    expect(layout.columns).toBe(4);
  });
});

const observers: Observer[] = [];
class Observer {
  constructor(readonly callback: ResizeObserverCallback) {
    observers.push(this);
  }
  observe = vi.fn();
  disconnect = vi.fn();
  emit(target: Element, width: number, height: number) {
    this.callback(
      [
        {
          target,
          contentRect: { width, height },
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
}
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
const cleanups: (() => void)[] = [];
function flushFrame() {
  const pending = [...frames.values()];
  frames.clear();
  pending.forEach((callback) => callback(0));
}
function setup(transition?: (update: () => void) => void) {
  return createRoot((dispose) => {
    cleanups.push(dispose);
    const element = document.createElement("div");
    const [count, setCount] = createSignal(4);
    const layout = createMeetingGridLayout(
      () => element,
      count,
      transition,
    );
    return { element, layout, setCount, dispose };
  });
}
beforeEach(() => {
  observers.length = 0;
  frames.clear();
  vi.stubGlobal("ResizeObserver", Observer);
  vi.stubGlobal(
    "requestAnimationFrame",
    vi.fn((callback: FrameRequestCallback) => {
      const id = ++nextFrame;
      frames.set(id, callback);
      return id;
    }),
  );
  vi.stubGlobal(
    "cancelAnimationFrame",
    vi.fn((id: number) => frames.delete(id)),
  );
});
afterEach(() => {
  cleanups.splice(0).forEach((dispose) => dispose());
  vi.unstubAllGlobals();
});

describe("meeting grid observer ownership", () => {
  it("transitions resize and source changes together, after the first measurement", () => {
    const transition = vi.fn((update: () => void) =>
      update(),
    );
    const f = setup(transition);
    const observer = observers[0];
    observer.emit(f.element, 800, 600);
    flushFrame();
    expect(transition).not.toHaveBeenCalled();

    const obsolete = vi.fn();
    const latest = vi.fn(() => f.setCount(6));
    f.layout.schedule(obsolete);
    observer.emit(f.element, 900, 600);
    f.layout.schedule(latest);
    observer.emit(f.element, 1000, 600);
    expect(frames.size).toBe(1);
    expect(f.layout().count).toBe(4);
    flushFrame();
    expect(obsolete).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();
    expect(transition).toHaveBeenCalledOnce();
    expect(f.layout().count).toBe(6);
    expect(observers).toHaveLength(1);
    observer.emit(f.element, 1000, 600);
    expect(frames.size).toBe(0);

    f.layout.schedule(obsolete);
    f.dispose();
    flushFrame();
    expect(obsolete).not.toHaveBeenCalled();
  });

  it("consumes an explicit measurement without replaying resize or dropping queued source changes", () => {
    const transition = vi.fn((update: () => void) =>
      update(),
    );
    const f = setup(transition);
    const observer = observers[0];
    Object.defineProperties(f.element, {
      clientWidth: { value: 900 },
      clientHeight: { value: 600 },
    });
    observer.emit(f.element, 800, 600);
    flushFrame();
    observer.emit(f.element, 850, 600);
    f.layout.measure();
    expect(frames.size).toBe(0);
    expect(transition).not.toHaveBeenCalled();
    observer.emit(f.element, 900, 600);
    expect(frames.size).toBe(0);

    f.layout.schedule(() => f.setCount(2));
    f.layout.measure();
    expect(frames.size).toBe(1);
    flushFrame();
    expect(f.layout().count).toBe(2);
    expect(transition).toHaveBeenCalledOnce();
  });

  it("observes one container and coalesces resize bursts to the latest size in one frame", () => {
    const f = setup();
    expect(observers).toHaveLength(1);
    const observer = observers[0];
    expect(observer.observe).toHaveBeenCalledOnce();
    expect(observer.observe).toHaveBeenCalledWith(
      f.element,
    );
    observer.emit(f.element, 800, 600);
    observer.emit(f.element, 320, 720);
    observer.emit(f.element, 1200, 200);
    expect(frames.size).toBe(1);
    expect(f.layout().tileWidth).toBe(0);
    flushFrame();
    expect([f.layout().columns, f.layout().rows]).toEqual([
      4, 1,
    ]);
    const settled = f.layout();
    observer.emit(f.element, 1200.8, 200.4);
    expect(frames.size).toBe(0);
    expect(f.layout()).toBe(settled);
    f.setCount(1);
    expect(f.layout().tileWidth).toBeCloseTo(
      (200 * 16) / 9,
      1,
    );
    expect(f.layout().columns).toBe(1);
    expect(observers).toHaveLength(1);
    expect(observer.observe).toHaveBeenCalledOnce();
  });

  it("recovers after the container is hidden and cancels pending work when unmounted", () => {
    const f = setup();
    const observer = observers[0];
    observer.emit(f.element, 800, 600);
    flushFrame();
    expect(f.layout().tileWidth).toBeGreaterThan(0);
    observer.emit(f.element, 0, 0);
    flushFrame();
    expect(f.layout().tileWidth).toBe(0);
    observer.emit(f.element, 320, 720);
    flushFrame();
    expect([f.layout().columns, f.layout().rows]).toEqual([
      1, 4,
    ]);
    observer.emit(f.element, 1200, 200);
    expect(frames.size).toBe(1);
    f.dispose();
    expect(observer.disconnect).toHaveBeenCalledOnce();
    expect(cancelAnimationFrame).toHaveBeenCalledOnce();
    expect(frames.size).toBe(0);
    observer.emit(f.element, 900, 400);
    expect(frames.size).toBe(0);
  });
});
