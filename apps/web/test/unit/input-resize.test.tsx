// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { textareaAutoResize } from "@/libs/hooks/input-resize";

const frames = new Map<number, FrameRequestCallback>();
let frameId = 0;
let measuredHeight = 88;
let inputWidth = 200;

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  targets = new Set<Element>();
  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  disconnect() {
    this.targets.clear();
  }
  deliver(width: number, height: number) {
    this.callback(
      [
        {
          contentRect: { width, height },
        } as ResizeObserverEntry,
      ],
      this as unknown as ResizeObserver,
    );
  }
}

function flushFrame() {
  const pending = [...frames.entries()];
  frames.clear();
  for (const [, callback] of pending) callback(0);
}

function mountInput(
  boxSizing: "border-box" | "content-box" = "border-box",
  height = "",
) {
  const [value, setValue] = createSignal("First\nSecond");
  const rendered = render(() => (
    <textarea
      rows={1}
      placeholder="A long placeholder must not determine the empty input height"
      style={{
        "box-sizing": boxSizing,
        width: "200px",
        padding: "4px",
        "border-width": "2px",
        "border-style": "solid",
        "max-height": "160px",
        height,
      }}
      value={value()}
      ref={(element) => textareaAutoResize(element, value)}
    />
  ));
  return {
    ...rendered,
    input: rendered.container.querySelector("textarea")!,
    setValue,
  };
}

beforeEach(() => {
  measuredHeight = 88;
  inputWidth = 200;
  frames.clear();
  frameId = 0;
  TestResizeObserver.instances = [];
  vi.stubGlobal(
    "requestAnimationFrame",
    (callback: FrameRequestCallback) => {
      frames.set(++frameId, callback);
      return frameId;
    },
  );
  vi.stubGlobal("cancelAnimationFrame", (id: number) =>
    frames.delete(id),
  );
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
  vi.spyOn(
    Element.prototype,
    "clientWidth",
    "get",
  ).mockImplementation(() => inputWidth);
  vi.spyOn(
    Element.prototype,
    "scrollHeight",
    "get",
  ).mockImplementation(function (this: HTMLElement) {
    // Any read from the live editor would reintroduce collapse-and-measure.
    expect(this.getAttribute("aria-hidden")).toBe("true");
    return measuredHeight;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("textarea autosizing without live layout measurement", () => {
  it("does not collapse or rewrite an expanded input when typing or focusing at the same height", () => {
    const { input } = mountInput("border-box", "92px");
    flushFrame();
    const writeHeight = vi.spyOn(
      input.style,
      "height",
      "set",
    );
    fireEvent.input(input, {
      target: { value: "First\nSecond updated" },
    });
    fireEvent.focus(input);
    expect(frames.size).toBe(1);
    flushFrame();
    expect(writeHeight).not.toHaveBeenCalled();
    expect(input.style.height).toBe("92px");
    const measurement =
      document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-hidden="true"]',
      )!;
    expect(measurement.value).toBe(input.value);
    expect(measurement.style.position).toBe("fixed");
    expect(measurement.tabIndex).toBe(-1);
    expect(measurement.name).toBe("");
    expect(measurement.placeholder).toBe("");
  });

  it("writes only the final height when content grows or shrinks", () => {
    const { input } = mountInput();
    flushFrame();
    const writeHeight = vi.spyOn(
      input.style,
      "height",
      "set",
    );
    measuredHeight = 128;
    fireEvent.input(input, {
      target: { value: "One\nTwo\nThree" },
    });
    flushFrame();
    measuredHeight = 48;
    fireEvent.input(input, { target: { value: "One" } });
    flushFrame();
    expect(writeHeight.mock.calls).toEqual([
      ["132px"],
      ["52px"],
    ]);
    expect(input.style.maxHeight).toBe("160px");
  });

  it.each([
    ["border-box", "92px"],
    ["content-box", "80px"],
  ] as const)(
    "accounts for padding and borders with %s",
    (boxSizing, height) => {
      const { input } = mountInput(boxSizing);
      flushFrame();
      expect(input.style.height).toBe(height);
    },
  );

  it("resizes programmatic drafts and restores native rows when cleared", () => {
    const { input, setValue } = mountInput();
    flushFrame();
    measuredHeight = 128;
    setValue("Restored\nmultiline\ndraft");
    flushFrame();
    expect(input.style.height).toBe("132px");
    setValue("");
    flushFrame();
    expect(input.style.height).toBe("");
    expect(input.rows).toBe(1);
  });

  it("leaves a hidden input intact and remeasures on width changes, not its own height changes", () => {
    inputWidth = 0;
    const { input } = mountInput("border-box", "60px");
    flushFrame();
    expect(input.style.height).toBe("60px");
    expect(
      document.querySelector(
        'textarea[aria-hidden="true"]',
      ),
    ).toBeNull();
    const observer = TestResizeObserver.instances[0];
    inputWidth = 200;
    observer.deliver(200, 60);
    flushFrame();
    expect(input.style.height).toBe("92px");
    observer.deliver(200, 92);
    expect(frames.size).toBe(0);
    inputWidth = 120;
    observer.deliver(120, 92);
    expect(frames.size).toBe(1);
    flushFrame();
  });

  it("removes the measurement node, listeners, observer and pending frame on cleanup", () => {
    const { input, unmount } = mountInput();
    flushFrame();
    expect(
      document.querySelector(
        'textarea[aria-hidden="true"]',
      ),
    ).not.toBeNull();
    fireEvent.input(input, {
      target: { value: "Next draft" },
    });
    expect(frames.size).toBe(1);
    unmount();
    expect(
      document.querySelector(
        'textarea[aria-hidden="true"]',
      ),
    ).toBeNull();
    expect(frames.size).toBe(0);
    expect(
      TestResizeObserver.instances[0].targets.size,
    ).toBe(0);
    fireEvent.input(input);
    expect(frames.size).toBe(0);
  });
});
