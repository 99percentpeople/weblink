// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
} from "@solidjs/testing-library";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createFloatingPanel } from "@/libs/hooks/create-floating-panel";

let disconnect: ReturnType<typeof vi.fn>;
beforeEach(() => {
  disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect = disconnect;
    },
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function setup() {
  let boundary!: HTMLDivElement;
  let panel!: HTMLDivElement;
  let handle!: HTMLButtonElement;
  let floating!: ReturnType<typeof createFloatingPanel>;
  const view = render(() => {
    floating = createFloatingPanel({
      boundary: () => boundary,
      panel: () => panel,
      handle: () => handle,
    });
    return (
      <div ref={boundary}>
        <div ref={panel}>
          <button ref={handle}>Move</button>
        </div>
      </div>
    );
  });
  // Supply a measurable surface; assertions cover input ownership and cleanup,
  // not CSS, pixel positions or layout geometry.
  Object.defineProperties(boundary, {
    clientWidth: { value: 800 },
    clientHeight: { value: 600 },
  });
  Object.defineProperties(panel, {
    offsetWidth: { value: 300 },
    offsetHeight: { value: 200 },
  });
  vi.spyOn(
    boundary,
    "getBoundingClientRect",
  ).mockReturnValue(new DOMRect(0, 0, 800, 600));
  const capture = vi.fn();
  const release = vi.fn();
  handle.setPointerCapture = capture;
  handle.hasPointerCapture = () => true;
  handle.releasePointerCapture = release;
  const pointer = (
    type: string,
    id = 1,
    primary = true,
  ) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      button: 0,
      clientX: 80,
      clientY: 80,
    });
    Object.defineProperties(event, {
      pointerId: { value: id },
      isPrimary: { value: primary },
    });
    fireEvent(handle, event);
    return event;
  };
  return {
    ...view,
    handle,
    floating,
    capture,
    release,
    pointer,
  };
}

it("owns only the primary drag pointer and ignores unrelated releases", () => {
  const { pointer, floating, capture, release, handle } =
    setup();
  pointer("pointerdown", 2, false);
  expect(capture).not.toHaveBeenCalled();
  expect(pointer("pointerdown").defaultPrevented).toBe(
    true,
  );
  expect(floating.dragging()).toBe(true);
  expect(document.activeElement).toBe(handle);
  pointer("pointerdown", 2);
  expect(capture).toHaveBeenCalledExactlyOnceWith(1);
  expect(pointer("pointermove", 2).defaultPrevented).toBe(
    false,
  );
  expect(pointer("pointermove").defaultPrevented).toBe(
    true,
  );
  pointer("pointerup", 2);
  expect(floating.dragging()).toBe(true);
  pointer("pointercancel");
  expect(floating.dragging()).toBe(false);
  expect(release).toHaveBeenCalledExactlyOnceWith(1);
});

it.each([
  "pointerup",
  "lostpointercapture",
  "blur",
  "fullscreenchange",
])("ends a drag on %s", (type) => {
  const { pointer, floating, release } = setup();
  pointer("pointerdown");
  if (type === "blur")
    window.dispatchEvent(new Event(type));
  else if (type === "fullscreenchange")
    document.dispatchEvent(new Event(type));
  else pointer(type);
  expect(floating.dragging()).toBe(false);
  expect(release).toHaveBeenCalledOnce();
});

it("releases capture, observers and input listeners when the window closes", () => {
  const {
    unmount,
    handle,
    pointer,
    capture,
    release,
    floating,
  } = setup();
  pointer("pointerdown");
  unmount();
  expect(disconnect).toHaveBeenCalledOnce();
  expect(release).toHaveBeenCalledOnce();
  expect(floating.dragging()).toBe(false);
  pointer("pointerdown");
  expect(capture).toHaveBeenCalledOnce();
  expect(
    fireEvent.keyDown(handle, { key: "ArrowRight" }),
  ).toBe(true);
});

it("handles movement keys without consuming modified or composing input", () => {
  const { handle } = setup();
  expect(
    fireEvent.keyDown(handle, { key: "ArrowRight" }),
  ).toBe(false);
  expect(fireEvent.keyDown(handle, { key: "Home" })).toBe(
    false,
  );
  expect(
    fireEvent.keyDown(handle, {
      key: "ArrowRight",
      ctrlKey: true,
    }),
  ).toBe(true);
  expect(
    fireEvent.keyDown(handle, {
      key: "ArrowRight",
      isComposing: true,
    }),
  ).toBe(true);
  expect(fireEvent.keyDown(handle, { key: "Tab" })).toBe(
    true,
  );
});
