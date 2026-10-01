// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import { RemoteControlOverlay } from "@/routes/home/components/remote-control-overlay";
import RemoteControlSettings from "@/components/settings/remote-control-settings";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

const fixture = vi.hoisted(() => ({
  control: undefined as any,
  video: undefined as any,
  error: vi.fn(),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: { error: fixture.error },
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {
    getRemoteControl: () => fixture.control,
  },
}));
vi.mock("@/routes/home/components/video-display", () => ({
  useVideoDisplay: () => ({
    videoTrack: () => ({}),
    videoRef: () => fixture.video,
  }),
}));
vi.mock("@/options", async () => {
  const { setAppState } =
    await import("@/libs/state/app-state");
  return {
    setAppOptions: (...args: unknown[]) =>
      Reflect.apply(setAppState, undefined, [
        "options",
        ...args,
      ]),
  };
});
class Control extends EventTarget {
  value = "active";
  capability = true;
  state = () => this.value;
  supportsTouch = () => this.capability;
  relative = false;
  pan = true;
  supportsTouchpadPan = () => this.pan;
  supportsRelativePointer = () => this.relative;
  trackpad = vi.fn();
  position = () => ({ x: 0.5, y: 0.5 });
  input = vi.fn();
  move = vi.fn();
  resetInput = vi.fn();
  cancel = vi.fn();
}
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  setAppState(reconcile(createInitialAppState()));
  fixture.control = new Control();
  fixture.error.mockClear();
  fixture.video = {
    ownerDocument: document,
    videoWidth: 200,
    videoHeight: 100,
    getBoundingClientRect: () => ({
      left: 0,
      top: 0,
      width: 200,
      height: 200,
    }),
  };
  Object.assign(HTMLElement.prototype, {
    setPointerCapture() {},
    hasPointerCapture() {
      return false;
    },
    releasePointerCapture() {},
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function surface() {
  return screen.getByRole("application");
}
function touch(
  phase: string,
  id: number,
  x: number,
  y: number,
) {
  const event = new Event(`pointer${phase}`, {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(event, {
    pointerType: "touch",
    pointerId: id,
    clientX: x,
    clientY: y,
  });
  fireEvent(surface(), event);
  return event;
}
it("routes mobile gestures as mouse input in trackpad mode", () => {
  render(() => <RemoteControlOverlay enabled />);
  expect(touch("down", 1, 60, 80).defaultPrevented).toBe(
    true,
  );
  touch("down", 2, 120, 80);
  touch("up", 1, 60, 80);
  touch("up", 2, 120, 80);
  expect(
    fixture.control.input.mock.calls.map(([e]: any[]) => [
      e.type,
      e.button,
      e.down,
    ]),
  ).toEqual([
    ["button", 2, true],
    ["button", 2, false],
  ]);
});
it("uses the host relative capability even when negotiated after the overlay mounted", () => {
  render(() => <RemoteControlOverlay enabled />);
  fixture.control.relative = true;
  touch("down", 1, 60, 80);
  touch("move", 1, 80, 90);
  touch("up", 1, 80, 90);
  expect(fixture.control.trackpad).toHaveBeenCalledWith({
    type: "move",
    x: 0.1,
    y: 0.1,
  });
  touch("down", 1, 60, 80);
  touch("up", 1, 60, 80);
  expect(fixture.control.trackpad).toHaveBeenLastCalledWith(
    { type: "button", button: 0, down: false },
  );
  expect(fixture.control.input).not.toHaveBeenCalled();
  expect(fixture.control.move).not.toHaveBeenCalled();
});
it("maps direct touches to video content and cancels contacts on mode change", () => {
  setAppState("options", "remoteTouch", "mode", "direct");
  render(() => <RemoteControlOverlay enabled />);
  touch("down", 1, 100, 20); // Letterbox is not the remote display.
  expect(fixture.control.input).not.toHaveBeenCalled();
  touch("down", 2, 100, 100);
  expect(fixture.control.input).toHaveBeenLastCalledWith({
    type: "touch",
    contacts: [{ id: 1, x: 0.5, y: 0.5, phase: "down" }],
  });
  setAppState("options", "remoteTouch", "mode", "trackpad");
  expect(fixture.control.input).toHaveBeenLastCalledWith({
    type: "touch",
    contacts: [{ id: 1, x: 0.5, y: 0.5, phase: "cancel" }],
  });
  expect(fixture.control.state()).toBe("active");
});
it("cancels direct touches when the browser cancels or the overlay unmounts", () => {
  setAppState("options", "remoteTouch", "mode", "direct");
  const view = render(() => (
    <RemoteControlOverlay enabled />
  ));
  touch("down", 10, 100, 100);
  touch("cancel", 10, 100, 100);
  expect(
    fixture.control.input.mock.calls.at(-1)[0].contacts[0]
      .phase,
  ).toBe("cancel");
  view.unmount();
  expect(fixture.control.state()).toBe("active");
});
it("does not silently emulate touch as mouse for an older host", () => {
  fixture.control.capability = false;
  setAppState("options", "remoteTouch", "mode", "direct");
  render(() => <RemoteControlOverlay enabled />);
  touch("down", 1, 100, 100);
  touch("up", 1, 100, 100);
  expect(fixture.control.input).not.toHaveBeenCalled();
  expect(fixture.error).toHaveBeenCalledWith(
    "setting.remote_control.unavailable",
  );
});
it("persists gesture choices and preserves them across direct mode", async () => {
  render(() => <RemoteControlSettings />);
  const speed = screen.getByRole("slider", {
    name: "setting.remote_control.scroll_speed",
    value: { now: 1 },
  });
  fireEvent.keyDown(speed, { key: "ArrowRight" });
  expect(appState.options.remoteTouch.scrollSpeed).toBe(
    1.05,
  );
  expect(appState.options.remoteTouch.pointerSpeed).toBe(1);
  const scroll = screen.getByRole("switch", {
    name: "setting.remote_control.twoFingerScroll",
  });
  fireEvent.click(scroll);
  expect(appState.options.remoteTouch.twoFingerScroll).toBe(
    false,
  );
  expect(
    screen.getByRole("switch", {
      name: "setting.remote_control.naturalScroll",
    }),
  ).toBeDisabled();
  fireEvent.keyDown(
    screen.getByRole("button", {
      name: /setting.remote_control.mode.title/,
    }),
    { key: "ArrowDown" },
  );
  fireEvent.click(
    await screen.findByRole("option", {
      name: "setting.remote_control.mode.direct",
    }),
  );
  expect(appState.options.remoteTouch.mode).toBe("direct");
  expect(
    screen.queryByRole("switch", {
      name: "setting.remote_control.twoFingerScroll",
    }),
  ).toBeNull();
  expect(
    screen.getByText(
      "setting.remote_control.mode.direct_description",
    ),
  ).toBeVisible();
  setAppState("options", "remoteTouch", "mode", "trackpad");
  expect(appState.options.remoteTouch.twoFingerScroll).toBe(
    false,
  );
});

it("reports unsupported native scrolling once per gesture without wheel fallback or losing control", () => {
  vi.useFakeTimers();
  fixture.control.pan = false;
  fixture.control.relative = true;
  render(() => <RemoteControlOverlay enabled />);
  touch("down", 1, 60, 80);
  touch("down", 2, 120, 80);
  touch("move", 1, 60, 120);
  touch("move", 2, 120, 120);
  vi.advanceTimersByTime(9);
  touch("move", 1, 60, 140);
  touch("move", 2, 120, 140);
  vi.advanceTimersByTime(9);
  touch("up", 1, 60, 140);
  touch("up", 2, 120, 140);
  expect(fixture.error).toHaveBeenCalledTimes(1);
  expect(fixture.error).toHaveBeenCalledWith(
    "setting.remote_control.pan_unavailable",
  );
  expect(fixture.control.input).not.toHaveBeenCalled();
  expect(fixture.control.trackpad).not.toHaveBeenCalled();
  expect(fixture.control.resetInput).not.toHaveBeenCalled();
  vi.useRealTimers();
});
