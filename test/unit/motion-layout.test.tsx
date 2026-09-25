// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { createEffect, createSignal, Show } from "solid-js";
import { Portal } from "solid-js/web";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { Motion } from "@/components/ui/motion";
import {
  createMotionLayout,
  createMotionLayoutRef,
  MotionLayout,
  layoutContainer,
  layoutScroll,
} from "@/components/ui/motion-layout";

const engine = vi.hoisted(() => ({
  animate: vi.fn(
    (
      _element: Element,
      _target: unknown,
      _options: unknown,
    ) => ({
      finished: new Promise<void>(() => {}),
      cancel: vi.fn(),
    }),
  ),
}));
vi.mock("motion/mini", () => ({ animate: engine.animate }));

beforeEach(() => {
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Motion layout ownership", () => {
  it("does not subscribe a transition's caller to layout metadata", () => {
    const [enabled, setEnabled] = createSignal(false);
    const invoked = vi.fn();
    render(() => {
      const group = createMotionLayout();
      createEffect(() => {
        group.transition(() => {});
        invoked();
      });
      return (
        <MotionLayout value={group}>
          <Motion.div layout={enabled()} />
        </MotionLayout>
      );
    });
    expect(invoked).toHaveBeenCalledOnce();
    setEnabled(true);
    expect(invoked).toHaveBeenCalledOnce();
  });

  it("keeps Portal registrations and external refs stable when their DOM host moves", () => {
    const [host, setHost] = createSignal<HTMLElement>();
    const [visible, setVisible] = createSignal(true);
    const forwardedRef = vi.fn();
    let group!: ReturnType<typeof createMotionLayout>;
    let second!: HTMLDivElement;
    const view = render(() => {
      group = createMotionLayout();
      return (
        <MotionLayout value={group}>
          <div ref={setHost} use:layoutContainer />
          <div ref={second} use:layoutContainer />
          <Show when={visible()}>
            <Portal mount={host()}>
              <div ref={forwardedRef} use:layoutScroll />
            </Portal>
          </Show>
        </MotionLayout>
      );
    });
    const scrollNode = [...group.registry.nodes].find(
      (node) => node.options().layoutScroll,
    )!;
    expect(group.registry.nodes.size).toBe(3);
    expect(host()!.contains(scrollNode.element)).toBe(true);
    setHost(second);
    expect(second.contains(scrollNode.element)).toBe(true);
    expect(group.registry.nodes.has(scrollNode)).toBe(true);
    expect(forwardedRef).toHaveBeenCalledOnce();
    setVisible(false);
    expect(group.registry.nodes.has(scrollNode)).toBe(
      false,
    );
    expect(group.registry.nodes.size).toBe(2);
    view.unmount();
    expect(group.registry.nodes.size).toBe(0);
  });

  it("isolates nested layout groups with the same IDs and cancels their animations on disposal", () => {
    let outer!: ReturnType<typeof createMotionLayout>;
    let inner!: ReturnType<typeof createMotionLayout>;
    let outerTile!: HTMLDivElement;
    let innerTile!: HTMLDivElement;
    const view = render(() => {
      outer = createMotionLayout();
      inner = createMotionLayout();
      return (
        <MotionLayout value={outer}>
          <Motion.div
            ref={outerTile}
            layout
            layoutId="source"
            style={{ opacity: 1 }}
          />
          <MotionLayout value={inner}>
            <Motion.div
              ref={innerTile}
              layout
              layoutId="source"
              style={{ opacity: 1 }}
            />
          </MotionLayout>
        </MotionLayout>
      );
    });
    for (const tile of [outerTile, innerTile])
      vi.spyOn(
        tile,
        "getBoundingClientRect",
      ).mockReturnValue(new DOMRect(0, 0, 320, 180));
    outer.transition(() => {});
    expect(engine.animate).toHaveBeenCalledOnce();
    expect(engine.animate.mock.calls[0][0]).toBe(outerTile);
    expect(innerTile.style.position).toBe("");
    inner.transition(() => {});
    expect(engine.animate.mock.calls[1][0]).toBe(innerTile);
    const animations = engine.animate.mock.results.map(
      (result) => result.value,
    );
    view.unmount();
    for (const animation of animations)
      expect(animation.cancel).toHaveBeenCalledOnce();
    expect(outer.registry.nodes.size).toBe(0);
    expect(inner.registry.nodes.size).toBe(0);
  });

  it("reads reactive layout options without remounting the element", () => {
    const [enabled, setEnabled] = createSignal(false);
    let group!: ReturnType<typeof createMotionLayout>;
    let tile!: HTMLDivElement;
    const forwardedRef = vi.fn(
      (element: HTMLDivElement) => {
        tile = element;
      },
    );
    render(() => {
      group = createMotionLayout();
      return (
        <MotionLayout value={group}>
          <Motion.div
            ref={forwardedRef}
            layout={enabled()}
            style={{ opacity: 1 }}
          />
        </MotionLayout>
      );
    });
    vi.spyOn(tile, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 320, 180),
    );
    group.transition(() => {});
    expect(engine.animate).not.toHaveBeenCalled();
    group.transition(() => setEnabled(true));
    expect(engine.animate).toHaveBeenCalledOnce();
    expect(forwardedRef).toHaveBeenCalledOnce();
    group.transition(() => setEnabled(false));
    expect(engine.animate).toHaveBeenCalledOnce();
    expect(tile.style.position).toBe("");
  });

  it("replaces a forwarded ref registration and releases it with its owner", () => {
    let group!: ReturnType<typeof createMotionLayout>;
    let register!: ReturnType<typeof createMotionLayoutRef>;
    const first = document.createElement("div");
    const second = document.createElement("div");
    const Host = () => {
      register = createMotionLayoutRef(() => ({
        layoutScroll: true,
      }));
      return null;
    };
    const view = render(() => {
      group = createMotionLayout();
      return (
        <MotionLayout value={group}>
          <Host />
        </MotionLayout>
      );
    });
    register(first);
    register(second);
    expect(
      [...group.registry.nodes].map((node) => node.element),
    ).toEqual([second]);
    view.unmount();
    expect(group.registry.nodes.size).toBe(0);
  });
});
