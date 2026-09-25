// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import {
  AnimatePresence,
  Motion,
} from "@/components/ui/motion";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createMotionLayout,
  MotionLayout,
  layoutScroll,
} from "@/components/ui/motion-layout";

const engine = vi.hoisted(() => ({
  animate: vi.fn(() => ({
    finished: Promise.resolve(),
    cancel: vi.fn(),
  })),
}));
vi.mock("motion/mini", () => ({ animate: engine.animate }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("shared layout state", () => {
  it("keeps scrollport children in flow and preserves scrolling across interrupted updates", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    let rail!: HTMLDivElement;
    let tile!: HTMLDivElement;
    let transition!: (update: () => void) => void;
    render(() => {
      const layout = createMotionLayout();
      transition = layout.transition;
      return (
        <MotionLayout value={layout}>
          <Motion.div ref={rail} layoutContainer>
            <Motion.div ref={tile} layout />
          </Motion.div>
        </MotionLayout>
      );
    });
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 500, 100),
    );
    vi.spyOn(tile, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 160, 90),
    );
    rail.scrollLeft = 300;
    transition(() => {});
    expect(tile.style.position).toBe("");
    expect(rail.scrollLeft).toBe(300);
    rail.scrollLeft = 180;
    transition(() => {});
    expect(tile.style.position).toBe("");
    expect(rail.scrollLeft).toBe(180);
    rail.scrollLeft = 240;
    await Promise.resolve();
    await Promise.resolve();
    expect(rail.scrollLeft).toBe(240);
    expect(tile.style.transform).toBe("");
    expect(engine.animate).toHaveBeenCalledTimes(2);
    for (const result of engine.animate.mock.results)
      expect(result.value.cancel).toHaveBeenCalledOnce();
  });

  it("still lifts reparented views out of flow and restores them after the transition", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    let rail!: HTMLDivElement;
    let frame!: HTMLDivElement;
    let tile!: HTMLDivElement;
    let move!: () => void;
    render(() => {
      const layout = createMotionLayout();
      const [featured, setFeatured] = createSignal(false);
      move = () =>
        layout.transition(() => setFeatured(true));
      return (
        <MotionLayout value={layout}>
          <Motion.div ref={rail} layoutContainer />
          <div ref={frame} />
          <Portal mount={featured() ? frame : rail}>
            <Motion.div ref={tile} layout />
          </Portal>
        </MotionLayout>
      );
    });
    vi.spyOn(rail, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 500, 100),
    );
    vi.spyOn(tile, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 160, 90),
    );
    move();
    expect(frame.contains(tile)).toBe(true);
    expect(tile.style.position).toBe("fixed");
    await Promise.resolve();
    await Promise.resolve();
    expect(frame.contains(tile)).toBe(true);
    expect(tile.style.position).toBe("");
    expect(tile.style.transform).toBe("");
  });

  it("undoes scroll clamping from height measurement without resetting later reader scrolling", async () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    let panel!: HTMLDivElement;
    let viewport!: HTMLDivElement;
    let transition!: (update: () => void) => void;
    let height = 400;
    render(() => {
      let root!: HTMLDivElement;
      const layout = createMotionLayout({
        root: () => root,
      });
      transition = layout.transition;
      return (
        <MotionLayout value={layout}>
          <div ref={root}>
            <Motion.div ref={panel} layout="height">
              <div ref={viewport} use:layoutScroll />
            </Motion.div>
          </div>
        </MotionLayout>
      );
    });
    vi.spyOn(
      panel,
      "getBoundingClientRect",
    ).mockImplementation(
      () => new DOMRect(0, 0, 320, height),
    );
    viewport.scrollTop = 1000;
    transition(() => {
      height = 480;
      // Expanding the scrollport clamps it before the starting height is animated.
      viewport.scrollTop = 920;
    });
    expect(engine.animate).toHaveBeenCalledOnce();
    expect(viewport.scrollTop).toBe(1000);
    viewport.scrollTop = 900;
    await Promise.resolve();
    await Promise.resolve();
    expect(viewport.scrollTop).toBe(900);
  });

  it("leaves exit opacity to presence and remembers a returning view's visible frame", () => {
    vi.stubGlobal("matchMedia", () => ({
      matches: false,
      addEventListener() {},
      removeEventListener() {},
    }));
    const [leaving, setLeaving] = createSignal(false);
    let tile!: HTMLDivElement;
    let transition!: (update: () => void) => void;
    render(() => {
      let root!: HTMLDivElement;
      const layout = createMotionLayout({
        root: () => root,
      });
      transition = layout.transition;
      return (
        <MotionLayout value={layout}>
          <div ref={root}>
            <AnimatePresence when={!leaving()}>
              <Motion.div
                ref={tile}
                layout
                layoutId="source"
                style={{ opacity: 1 }}
              />
            </AnimatePresence>
          </div>
        </MotionLayout>
      );
    });
    vi.spyOn(tile, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 320, 180),
    );
    transition(() => setLeaving(true));
    expect(engine.animate).not.toHaveBeenCalled();
    expect(tile.style.position).toBe("");
    transition(() => setLeaving(false));
    expect(engine.animate).toHaveBeenCalledWith(
      tile,
      expect.objectContaining({ opacity: [1, 1] }),
      expect.anything(),
    );
  });

  it("commits the rendered value before measuring a shared state change", async () => {
    const [collapsed, setCollapsed] = createSignal(false);
    const measured: string[] = [];
    render(() => {
      let output!: HTMLOutputElement;
      const layout = createMotionLayout({
        root: () => output,
        afterUpdate: () =>
          measured.push(output.textContent!),
      });
      const displayed = layout.value(collapsed);
      return (
        <output ref={output}>
          {displayed() ? "collapsed" : "expanded"}
        </output>
      );
    });
    setCollapsed(true);
    await Promise.resolve();
    setCollapsed(false);
    await Promise.resolve();
    expect(measured).toEqual(["collapsed", "expanded"]);
  });

  it("coalesces pending changes and ignores them after disposal", async () => {
    const [value, setValue] = createSignal("initial");
    const measured: string[] = [];
    const view = render(() => {
      let output!: HTMLOutputElement;
      const layout = createMotionLayout({
        root: () => output,
        afterUpdate: () =>
          measured.push(output.textContent!),
      });
      const displayed = layout.value(value);
      return <output ref={output}>{displayed()}</output>;
    });
    setValue("discarded");
    setValue("latest");
    await Promise.resolve();
    expect(measured).toEqual(["latest"]);
    setValue("unmounted");
    view.unmount();
    await Promise.resolve();
    expect(measured).toEqual(["latest"]);
  });
});
