// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createLayoutTransition,
  createLayoutValue,
} from "@/libs/hooks/layout-transition";

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
      transition = createLayoutTransition(() => root);
      return (
        <div ref={root}>
          <div
            ref={tile}
            data-motion-layout="source"
            data-motion-layout-exiting={
              leaving() ? "" : undefined
            }
            style={{ opacity: 1 }}
          />
        </div>
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
      const transition = createLayoutTransition(
        () => output,
        undefined,
        () => measured.push(output.textContent!),
      );
      const displayed = createLayoutValue(
        collapsed,
        transition,
      );
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
      const transition = createLayoutTransition(
        () => output,
        undefined,
        () => measured.push(output.textContent!),
      );
      const displayed = createLayoutValue(
        value,
        transition,
      );
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
