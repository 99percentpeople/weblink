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
import { createSignal } from "solid-js";
import { reconcile } from "solid-js/store";
import type { TouchContact } from "@/libs/domain/remote-control/touch-types";
import { RemoteControlOverlay } from "@/routes/home/components/remote-control-overlay";
import { createControlState } from "@/routes/home/components/remote-control-action";
import {
  RemoteKeyboardInput,
  type RemoteKeyboardInputHandle,
} from "@/routes/home/components/remote-keyboard-input";
import RemoteControlSettings from "@/components/settings/remote-control-settings";
import { SettingsStateProvider } from "../helpers/settings-state";
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
vi.mock(
  "@/routes/home/components/video-display-context",
  () => ({
    useVideoDisplay: () => ({
      videoTrack: () => ({}),
      videoRef: () => fixture.video,
    }),
  }),
);
vi.mock(
  "@/routes/home/components/video-display",
  () => ({}),
);
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
  supportsText = () => true;
  supportsKeyboard = () => true;
  relative = false;
  pan = true;
  supportsTouchpadPan = () => this.pan;
  supportsRelativePointer = () => this.relative;
  trackpad = vi.fn();
  position = () => ({ x: 0.5, y: 0.5 });
  input = vi.fn(() => true);
  move = vi.fn();
  resetInput = vi.fn();
  setCursorVisible = vi.fn();
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
  Reflect.deleteProperty(navigator, "virtualKeyboard");
  Reflect.deleteProperty(window, "visualViewport");
  Reflect.deleteProperty(document, "fullscreenElement");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  properties: Partial<PointerEvent> = {},
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
    ...properties,
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
  expect(fixture.control.trackpad).toHaveBeenCalledWith(
    {
      type: "move",
      x: 0.1,
      y: 0.1,
    },
    120,
  );
  touch("down", 1, 60, 80);
  touch("up", 1, 60, 80);
  expect(fixture.control.trackpad).toHaveBeenLastCalledWith(
    { type: "button", button: 0, down: false },
    120,
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
  render(() => (
    <SettingsStateProvider>
      <RemoteControlSettings />
    </SettingsStateProvider>
  ));
  expect(appState.options.remoteTouch.threeFingerTap).toBe(
    "keyboard",
  );
  fireEvent.keyDown(
    screen.getByRole("button", {
      name: /setting.remote_control.three_finger_tap.title/,
    }),
    { key: "ArrowDown" },
  );
  fireEvent.click(
    await screen.findByRole("option", {
      name: "setting.remote_control.three_finger_tap.none",
    }),
  );
  expect(appState.options.remoteTouch.threeFingerTap).toBe(
    "none",
  );
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
    screen.queryByRole("button", {
      name: /setting.remote_control.three_finger_tap.title/,
    }),
  ).toBeNull();
  expect(appState.options.remoteTouch.threeFingerTap).toBe(
    "none",
  );
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
  expect(
    screen.getByRole("button", {
      name: /setting.remote_control.three_finger_tap.title/,
    }),
  ).toBeVisible();
  expect(appState.options.remoteTouch.twoFingerScroll).toBe(
    false,
  );
});

it("offers sampling rates in both modes and remembers the direct touch property switch", async () => {
  render(() => (
    <SettingsStateProvider>
      <RemoteControlSettings />
    </SettingsStateProvider>
  ));
  expect(appState.options.remoteTouch.sampleRate).toBe(120);
  fireEvent.keyDown(
    screen.getByRole("button", {
      name: /setting.remote_control.sample_rate.title/,
    }),
    { key: "ArrowDown" },
  );
  fireEvent.click(
    await screen.findByRole("option", { name: "240 Hz" }),
  );
  expect(appState.options.remoteTouch.sampleRate).toBe(240);
  setAppState("options", "remoteTouch", "mode", "direct");
  expect(
    screen.getByRole("button", {
      name: /setting.remote_control.sample_rate.title/,
    }),
  ).toHaveTextContent("240 Hz");
  expect(
    screen.getByRole("switch", {
      name: "setting.remote_control.forwardProperties",
    }),
  ).not.toBeChecked();
  fireEvent.click(
    screen.getByRole("switch", {
      name: "setting.remote_control.forwardProperties",
    }),
  );
  expect(
    appState.options.remoteTouch.forwardProperties,
  ).toBe(true);
  setAppState("options", "remoteTouch", "mode", "trackpad");
  setAppState("options", "remoteTouch", "mode", "direct");
  expect(
    screen.getByRole("switch", {
      name: "setting.remote_control.forwardProperties",
    }),
  ).toBeChecked();
});

it("forwards contact properties using video content size and cancels the gesture when the switch changes", () => {
  setAppState("options", "remoteTouch", "mode", "direct");
  setAppState(
    "options",
    "remoteTouch",
    "forwardProperties",
    true,
  );
  render(() => <RemoteControlOverlay enabled />);
  const properties = {
    pressure: 0.3,
    width: 20,
    height: 15,
  };
  touch("down", 1, 100, 100, properties);
  expect(fixture.control.input).toHaveBeenLastCalledWith({
    type: "touch",
    contacts: [
      {
        id: 1,
        x: 0.5,
        y: 0.5,
        phase: "down",
        pressure: 0.3,
        width: 0.1,
        height: 0.15,
      },
    ],
  });
  setAppState(
    "options",
    "remoteTouch",
    "forwardProperties",
    false,
  );
  expect(
    fixture.control.input.mock.calls.at(-1)[0].contacts[0]
      .phase,
  ).toBe("cancel");
  touch("down", 2, 100, 100, properties);
  expect(fixture.control.input).toHaveBeenLastCalledWith({
    type: "touch",
    contacts: [{ id: 1, x: 0.5, y: 0.5, phase: "down" }],
  });
  touch("up", 2, 100, 100, { ...properties, pressure: 0 });
});

it("does not misinterpret coalesced out-and-back motion as a tap and applies the selected trackpad rate", () => {
  setAppState("options", "remoteTouch", "sampleRate", 30);
  render(() => <RemoteControlOverlay enabled />);
  touch("down", 1, 60, 80);
  const samples = [100, 60].map((clientX) =>
    Object.assign(new Event("pointermove"), {
      pointerId: 1,
      pointerType: "touch",
      clientX,
      clientY: 80,
    }),
  ) as PointerEvent[];
  touch("move", 1, 60, 80, {
    getCoalescedEvents: () => samples,
  });
  touch("up", 1, 60, 80);
  expect(fixture.control.move).toHaveBeenCalledTimes(2);
  expect(
    fixture.control.move.mock.calls.at(-1)[0].x,
  ).toBeCloseTo(0.5);
  expect(fixture.control.move).toHaveBeenLastCalledWith(
    { x: expect.any(Number), y: 0.5 },
    30,
  );
  expect(fixture.control.input).not.toHaveBeenCalled();
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

function renderKeyboardControl() {
  vi.stubGlobal("innerWidth", 390);
  window.dispatchEvent(new Event("resize"));
  let keyboard: RemoteKeyboardInputHandle | undefined;
  const view = render(() => {
    const { state } = createControlState(
      () => fixture.control,
    );
    return (
      <>
        <RemoteControlOverlay
          enabled
          keyboard={() => keyboard}
        />
        <RemoteKeyboardInput
          control={fixture.control}
          state={state()}
          enabled
          registerKeyboard={(input) => {
            keyboard = input;
            return () => {
              keyboard = undefined;
            };
          }}
        />
      </>
    );
  });
  const editor = screen.queryByRole(
    "textbox",
  ) as HTMLTextAreaElement;
  return { ...view, editor, keyboard: () => keyboard };
}

function threeFingerTap() {
  for (const id of [1, 2, 3])
    touch("down", id, id * 40, 80);
  for (const id of [1, 2, 3]) touch("up", id, id * 40, 80);
}

function nativeTouch(type: string, remaining = 0) {
  const event = new Event(type, {
    bubbles: true,
    cancelable: true,
  });
  Object.assign(event, {
    touches: Array.from({ length: remaining }),
  });
  fireEvent(surface(), event);
  return event;
}

it("recognizes the trackpad shortcut across video letterboxing", () => {
  const { editor } = renderKeyboardControl();
  const contacts = [
    [1, 20],
    [2, 80],
    [3, 180],
  ];
  for (const [id, y] of contacts) {
    touch("down", id, id * 40, y);
    nativeTouch("touchstart", id);
  }
  for (const [id, y] of contacts)
    touch("up", id, id * 40, y);
  nativeTouch("touchend");
  expect(editor).toHaveFocus();
  expect(fixture.control.input).not.toHaveBeenCalled();
});

it.each(["end", "cancel"])(
  "forwards three direct contacts without a keyboard shortcut on %s",
  (phase) => {
    setAppState("options", "remoteTouch", "mode", "direct");
    const { editor, keyboard } = renderKeyboardControl();
    const show = vi.spyOn(keyboard()!, "show");
    for (const id of [1, 2, 3]) {
      touch("down", id, id * 40, 80);
      nativeTouch("touchstart", id);
    }
    expect(
      fixture.control.input.mock.calls.at(-1)[0].contacts,
    ).toHaveLength(3);
    for (const id of [1, 2, 3])
      touch(
        phase === "end" ? "up" : "cancel",
        id,
        id * 40,
        80,
      );
    nativeTouch(
      phase === "end" ? "touchend" : "touchcancel",
    );
    expect(editor).not.toHaveFocus();
    expect(show).not.toHaveBeenCalled();
    expect(
      fixture.control.input.mock.calls
        .at(-1)[0]
        .contacts.every(
          (c: any) =>
            c.phase === (phase === "end" ? "up" : "cancel"),
        ),
    ).toBe(true);
  },
);

it("keeps a captured direct contact alive outside the video and after returning", () => {
  vi.useFakeTimers();
  setAppState("options", "remoteTouch", "mode", "direct");
  render(() => <RemoteControlOverlay enabled />);
  touch("down", 10, 100, 100);
  touch("move", 10, -40, 220);
  vi.advanceTimersByTime(17);
  expect(fixture.control.input).toHaveBeenLastCalledWith({
    type: "touch",
    contacts: [{ id: 1, x: 0, y: 1, phase: "update" }],
  });
  touch("move", 10, 150, 75);
  vi.advanceTimersByTime(17);
  expect(fixture.control.input).toHaveBeenLastCalledWith({
    type: "touch",
    contacts: [
      { id: 1, x: 0.75, y: 0.25, phase: "update" },
    ],
  });
  touch("up", 10, 260, 100);
  expect(fixture.control.input).toHaveBeenLastCalledWith({
    type: "touch",
    contacts: [{ id: 1, x: 1, y: 0.5, phase: "up" }],
  });
  const events: { contacts: TouchContact[] }[] =
    fixture.control.input.mock.calls.map(([e]: any[]) => e);
  expect(
    events
      .flatMap((e) => e.contacts)
      .some((c) => c.phase === "cancel"),
  ).toBe(false);
  const count = events.length;
  vi.advanceTimersByTime(200);
  expect(fixture.control.input).toHaveBeenCalledTimes(
    count,
  );
  // A gesture must still start inside the actual video, not in its black bars.
  touch("down", 11, 100, 20);
  touch("move", 11, 100, 100);
  touch("up", 11, 100, 100);
  expect(fixture.control.input).toHaveBeenCalledTimes(
    count,
  );
});

it("opens the keyboard in native touchcancel after a three-finger trackpad gesture", () => {
  const { editor, keyboard } = renderKeyboardControl();
  const show = vi.spyOn(keyboard()!, "show");
  // A real focus handoff resets the remote epoch synchronously.
  fixture.control.resetInput.mockImplementation(() => {
    fixture.control.value = "activating";
    fixture.control.dispatchEvent(new Event("change"));
  });
  for (const id of [1, 2]) {
    touch("down", id, id * 40, 80);
    expect(
      nativeTouch("touchstart", id).defaultPrevented,
    ).toBe(id > 1);
    expect(editor).not.toHaveFocus();
  }
  touch("down", 3, 120, 80);
  expect(editor).not.toHaveFocus();
  expect(show).not.toHaveBeenCalled();
  nativeTouch("touchstart", 3);
  // Replay the phone trace: no pointerup or touchend reaches the page.
  for (const id of [1, 2, 3])
    touch("cancel", id, id * 40, 80);
  expect(show).not.toHaveBeenCalled();
  nativeTouch("touchcancel");
  expect(editor).toHaveFocus();
  expect(show).toHaveBeenCalledOnce();
  expect(fixture.control.resetInput).toHaveBeenCalledOnce();
  fixture.control.value = "active";
  fixture.control.dispatchEvent(new Event("change"));
  fixture.control.input.mockClear();
  touch("down", 4, 100, 80);
  nativeTouch("touchstart", 1);
  touch("up", 4, 100, 80);
  nativeTouch("touchend");
  expect(show).toHaveBeenCalledOnce();
  expect(editor.getAttribute("virtualkeyboardpolicy")).toBe(
    "manual",
  );
  expect(fixture.control.input).toHaveBeenCalled();
});

it.each([false, true])(
  "reopens IME on trackpad touchcancel without resetting the keyboard session (secure API=%s)",
  (withAPI) => {
    if (withAPI)
      Object.defineProperty(navigator, "virtualKeyboard", {
        configurable: true,
        value: Object.assign(new EventTarget(), {
          boundingRect: { height: 0 },
        }),
      });
    const { editor, keyboard } = renderKeyboardControl();
    keyboard()?.show();
    const show = vi.spyOn(keyboard()!, "show");
    const focus = vi.spyOn(editor, "focus");
    const blur = vi.spyOn(editor, "blur");
    const resetCount =
      fixture.control.resetInput.mock.calls.length;
    for (let attempt = 0; attempt < 5; attempt++) {
      // Android Back can leave this exact editor focused, with no viewport event.
      for (const id of [1, 2, 3]) {
        touch("down", id, id * 40, 80);
        nativeTouch("touchstart", id);
      }
      for (const id of [1, 2, 3])
        touch("cancel", id, id * 40, 80);
      nativeTouch("touchcancel");
      expect(editor).toHaveFocus();
      expect(show).toHaveBeenCalledTimes(attempt + 1);
      expect(focus).toHaveBeenCalledTimes(attempt + 1);
      expect(blur).toHaveBeenCalledTimes(attempt + 1);
      expect(
        fixture.control.resetInput,
      ).toHaveBeenCalledTimes(resetCount);
      touch("down", 4, 100, 80);
      nativeTouch("touchstart", 1);
      touch("up", 4, 100, 80);
      nativeTouch("touchend");
      expect(show).toHaveBeenCalledTimes(attempt + 1);
      expect(
        editor.getAttribute("virtualkeyboardpolicy"),
      ).toBe("manual");
    }
    fireEvent.compositionStart(editor);
    editor.value = "待输入";
    for (const id of [1, 2, 3]) {
      touch("down", id, id * 40, 80);
      nativeTouch("touchstart", id);
    }
    for (const id of [1, 2, 3])
      touch("cancel", id, id * 40, 80);
    nativeTouch("touchcancel");
    expect(editor.value).toBe("待输入");
    expect(editor).toHaveFocus();
    expect(focus).toHaveBeenCalledTimes(5);
    expect(
      fixture.control.resetInput,
    ).toHaveBeenCalledTimes(resetCount);
  },
);

it.each([1, 2, 4])(
  "does not open the keyboard when %i contacts are cancelled",
  (count) => {
    const { editor, keyboard } = renderKeyboardControl();
    const show = vi.spyOn(keyboard()!, "show");
    for (let id = 1; id <= count; id++) {
      touch("down", id, id * 30, 80);
      nativeTouch("touchstart", id);
    }
    for (let id = 1; id <= count; id++)
      touch("cancel", id, id * 30, 80);
    nativeTouch("touchcancel");
    expect(show).not.toHaveBeenCalled();
    expect(editor).not.toHaveFocus();
  },
);

it("can activate from touchcancel without a preceding pointercancel", () => {
  const { editor, keyboard } = renderKeyboardControl();
  const show = vi.spyOn(keyboard()!, "show");
  for (const id of [1, 2, 3]) {
    touch("down", id, id * 40, 80);
    nativeTouch("touchstart", id);
  }
  nativeTouch("touchcancel");
  expect(editor).toHaveFocus();
  nativeTouch("touchcancel");
  for (const id of [1, 2, 3])
    touch("cancel", id, id * 40, 80);
  expect(show).toHaveBeenCalledOnce();
});

it.each(["setting", "revoke"])(
  "discards a pending cancellation shortcut on %s",
  (reason) => {
    const { editor, keyboard } = renderKeyboardControl();
    const show = vi.spyOn(keyboard()!, "show");
    const target = surface();
    for (const id of [1, 2, 3]) {
      touch("down", id, id * 40, 80);
      nativeTouch("touchstart", id);
    }
    for (const id of [1, 2, 3])
      touch("cancel", id, id * 40, 80);
    if (reason === "setting")
      setAppState(
        "options",
        "remoteTouch",
        "threeFingerTap",
        "none",
      );
    else {
      fixture.control.value = "viewing";
      fixture.control.dispatchEvent(new Event("change"));
    }
    fireEvent(
      target,
      new Event("touchcancel", { bubbles: true }),
    );
    expect(editor).not.toHaveFocus();
    expect(show).not.toHaveBeenCalled();
  },
);

it.each(["touchcancel", "setting", "revoke"])(
  "does not activate a shortcut interrupted before the third contact by %s",
  (reason) => {
    const { editor, keyboard } = renderKeyboardControl();
    const show = vi.spyOn(keyboard()!, "show");
    for (const id of [1, 2]) {
      touch("down", id, id * 40, 80);
      nativeTouch("touchstart", id);
    }
    if (reason === "touchcancel")
      nativeTouch("touchcancel");
    if (reason === "setting")
      setAppState(
        "options",
        "remoteTouch",
        "threeFingerTap",
        "none",
      );
    if (reason === "revoke") {
      fixture.control.value = "viewing";
      fixture.control.dispatchEvent(new Event("change"));
    } else {
      touch("down", 3, 120, 80);
      nativeTouch("touchstart", 1);
    }
    expect(editor).not.toHaveFocus();
    expect(show).not.toHaveBeenCalled();
  },
);

it("initializes the editor after control becomes active and recreates it after reconnecting", () => {
  fixture.control.value = "viewing";
  const view = renderKeyboardControl();
  expect(screen.queryByRole("textbox")).toBeNull();
  const change = (value: string) => {
    fixture.control.value = value;
    fixture.control.dispatchEvent(new Event("change"));
  };
  change("active");
  const first = screen.getByRole("textbox");
  threeFingerTap();
  expect(first).toHaveFocus();
  change("unavailable");
  expect(screen.queryByRole("textbox")).toBeNull();
  change("active");
  const second = screen.getByRole("textbox");
  expect(second).not.toBe(first);
  threeFingerTap();
  expect(second).toHaveFocus();
  view.unmount();
  expect(view.keyboard()).toBeUndefined();
});

it("opens the keyboard on normal three-finger trackpad release without completing a remote gesture", () => {
  const { editor } = renderKeyboardControl();
  for (const id of [1, 2, 3])
    touch("down", id, id * 40, 80);
  expect(editor).not.toHaveFocus();
  touch("up", 2, 80, 80);
  touch("up", 1, 40, 80);
  expect(editor).not.toHaveFocus();
  touch("up", 3, 120, 80);
  expect(editor).toHaveFocus();
  expect(fixture.control.input).not.toHaveBeenCalled();
  expect(fixture.control.trackpad).toHaveBeenLastCalledWith(
    {
      type: "pan",
      phase: "cancel",
    },
  );
  // This is an open shortcut, not a toggle, and cannot discard an IME composition.
  fireEvent.compositionStart(editor);
  editor.value = "待输入";
  fireEvent.input(editor, {
    inputType: "insertCompositionText",
    isComposing: true,
  });
  threeFingerTap();
  expect(editor).toHaveFocus();
  expect(editor.value).toBe("待输入");
});

it.each(["move", "hold"])(
  "does not activate after %s before the third contact",
  (reason) => {
    vi.useFakeTimers({ toFake: ["performance"] });
    const { editor, keyboard } = renderKeyboardControl();
    const show = vi.spyOn(keyboard()!, "show");
    for (const id of [1, 2]) touch("down", id, id * 40, 80);
    if (reason === "move") touch("move", 1, 65, 80);
    else vi.advanceTimersByTime(601);
    fixture.control.input.mockClear();
    touch("down", 3, 120, 80);
    for (const id of [1, 2, 3])
      touch("up", id, id * 40, 80);
    expect(editor).not.toHaveFocus();
    expect(show).not.toHaveBeenCalled();
    expect(fixture.control.input).not.toHaveBeenCalled();
    touch("down", 5, 100, 80);
    touch("up", 5, 100, 80);
    expect(fixture.control.input).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "button",
        button: 0,
        down: false,
      }),
    );
  },
);

it("does not open the keyboard for isolated single- or two-finger input", () => {
  const { editor, keyboard } = renderKeyboardControl();
  const show = vi.spyOn(keyboard()!, "show");
  for (const ids of [[1], [2, 3], [4], [5, 6]]) {
    for (const id of ids) touch("down", id, 80, 80);
    for (const id of ids) touch("up", id, 80, 80);
  }
  expect(editor).not.toHaveFocus();
  expect(show).not.toHaveBeenCalled();
});

it.each(["shortcut", "keyboard"])(
  "preserves native three-contact input when %s is disabled",
  (disabled) => {
    setAppState("options", "remoteTouch", "mode", "direct");
    if (disabled === "shortcut")
      setAppState(
        "options",
        "remoteTouch",
        "threeFingerTap",
        "none",
      );
    else
      setAppState(
        "options",
        "remoteKeyboard",
        "enabled",
        false,
      );
    renderKeyboardControl();
    threeFingerTap();
    expect(document.activeElement).not.toBe(
      screen.queryByRole("textbox"),
    );
    expect(fixture.control.input).toHaveBeenLastCalledWith({
      type: "touch",
      contacts: [{ id: 3, x: 0.6, y: 0.3, phase: "up" }],
    });
  },
);

it.each(["local", "capture"] as const)(
  "keeps the soft-keyboard editor focused through pointer gestures and sends subsequent text (%s)",
  (mode) => {
    setAppState("options", "remotePointer", "mode", mode);
    const { editor, keyboard } = renderKeyboardControl();
    keyboard()?.show();
    touch("down", 1, 60, 80);
    touch("move", 1, 80, 90);
    touch("up", 1, 80, 90);
    expect(editor).toHaveFocus();
    expect(fixture.control.move).toHaveBeenCalled();
    const mouse = new MouseEvent("pointerdown", {
      bubbles: true,
      cancelable: true,
      clientX: 100,
      clientY: 80,
      button: 0,
    });
    Object.assign(mouse, {
      pointerType: "mouse",
      pointerId: 10,
    });
    fireEvent(surface(), mouse);
    expect(mouse.defaultPrevented).toBe(true);
    expect(editor).toHaveFocus();
    // Some browsers also dispatch compatibility mouse events.
    expect(fireEvent.mouseDown(surface())).toBe(false);
    fireEvent.wheel(surface(), {
      clientX: 100,
      clientY: 80,
      deltaY: 120,
    });
    expect(editor).toHaveFocus();
    editor.value = "hello";
    fireEvent.input(editor, {
      inputType: "insertText",
      data: "hello",
    });
    expect(fixture.control.input).toHaveBeenLastCalledWith({
      type: "text",
      text: "hello",
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "remote_control.keyboard_hide",
      }),
    );
    expect(editor).not.toHaveFocus();
    touch("down", 2, 60, 80);
    expect(surface()).toHaveFocus();
  },
);

it.each(["trackpad", "direct"] as const)(
  "suppresses automatic keyboard reopening during %s input on HTTP, even without a resize or blur",
  (mode) => {
    setAppState("options", "remoteTouch", "mode", mode);
    const { editor, keyboard } = renderKeyboardControl();
    keyboard()?.show();
    // This is also the DOM state after Back dismisses a floating keyboard.
    for (const id of [1, 2]) {
      touch("down", id, 60, 80);
      nativeTouch("touchstart", 1);
      touch("up", id, 60, 80);
      nativeTouch("touchend");
      expect(editor).toHaveFocus();
      expect(
        editor.getAttribute("virtualkeyboardpolicy"),
      ).toBe("manual");
    }
    // Only trackpad mode treats three contacts as an explicit local shortcut.
    for (const id of [1, 2, 3]) {
      touch("down", id, id * 40, 80);
      nativeTouch("touchstart", id);
    }
    for (const id of [1, 2, 3])
      touch("up", id, id * 40, 80);
    nativeTouch("touchend");
    expect(editor).toHaveFocus();
    expect(
      editor.getAttribute("virtualkeyboardpolicy"),
    ).toBe(mode === "trackpad" ? "auto" : "manual");
  },
);

it.each(["geometry", "viewport"])(
  "updates the fullscreen keyboard action after Back and does not reopen it on a screen tap (%s)",
  (signal) => {
    vi.useFakeTimers();
    const api = Object.assign(new EventTarget(), {
      boundingRect: { height: 0 },
      show: vi.fn(),
      hide: vi.fn(),
    });
    const viewport = Object.assign(new EventTarget(), {
      height: 800,
      width: 400,
      scale: 1,
    });
    Object.defineProperty(navigator, "virtualKeyboard", {
      configurable: true,
      value: api,
    });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    const { editor, keyboard, container } =
      renderKeyboardControl();
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: container,
    });
    keyboard()?.show();
    if (signal === "geometry") {
      api.boundingRect.height = 300;
      api.dispatchEvent(new Event("geometrychange"));
      api.boundingRect.height = 0;
      api.dispatchEvent(new Event("geometrychange"));
    } else {
      viewport.height = 480;
      viewport.dispatchEvent(new Event("resize"));
      viewport.height = 800;
      viewport.dispatchEvent(new Event("resize"));
    }
    expect(
      screen.getByRole("button", {
        name: "remote_control.keyboard_hide",
      }),
    ).toBeDefined();
    // The tap can arrive before the final IME animation/dismissal timer settles.
    touch("down", 1, 60, 80);
    touch("up", 1, 60, 80);
    vi.advanceTimersByTime(250);
    expect(editor).not.toHaveFocus();
    touch("down", 2, 60, 80);
    touch("up", 2, 60, 80);
    expect(surface()).toHaveFocus();
    expect(api.show).not.toHaveBeenCalled();
    expect(document.fullscreenElement).toBe(container);
  },
);

it("does not preserve another editor's focus and unregisters the shortcut on teardown", () => {
  const view = renderKeyboardControl();
  const other = document.createElement("textarea");
  document.body.append(other);
  other.focus();
  touch("down", 1, 60, 80);
  expect(surface()).toHaveFocus();
  view.keyboard()?.show();
  other.focus();
  expect(view.editor).not.toHaveFocus();
  view.unmount();
  expect(view.keyboard()).toBeUndefined();
  expect(other).toHaveFocus();
  other.remove();
});

it.each(["local", "capture"] as const)(
  "preserves native long press and holds a trackpad drag through movement until lift (%s)",
  (mode) => {
    setAppState("options", "remotePointer", "mode", mode);
    render(() => <RemoteControlOverlay enabled />);
    touch("down", 1, 60, 80);
    expect(
      nativeTouch("touchstart", 1).defaultPrevented,
    ).toBe(false);
    const menu = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    Object.assign(menu, { pointerType: "touch" });
    fireEvent(surface(), menu);
    expect(menu.defaultPrevented).toBe(true);
    expect(fixture.control.input).toHaveBeenLastCalledWith(
      expect.objectContaining({
        type: "button",
        button: 0,
        down: true,
      }),
    );
    touch("move", 1, 80, 90);
    expect(
      nativeTouch("touchmove", 1).defaultPrevented,
    ).toBe(false);
    expect(fixture.control.move).toHaveBeenCalled();
    fireEvent(surface(), menu);
    touch("up", 1, 80, 90);
    nativeTouch("touchend");
    expect(
      fixture.control.input.mock.calls.map(([e]: any[]) => [
        e.button,
        e.down,
      ]),
    ).toEqual([
      [0, true],
      [0, false],
    ]);
  },
);

it("keeps direct contacts held through a local context menu without emulating a mouse press", () => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "setInterval",
      "clearInterval",
      "performance",
    ],
  });
  setAppState("options", "remoteTouch", "mode", "direct");
  render(() => <RemoteControlOverlay enabled />);
  touch("down", 1, 60, 80);
  nativeTouch("touchstart", 1);
  vi.advanceTimersByTime(500);
  fireEvent.contextMenu(surface());
  vi.advanceTimersByTime(500);
  touch("move", 1, 80, 90);
  touch("up", 1, 80, 90);
  const events = fixture.control.input.mock.calls.map(
    ([e]: any[]) => e,
  );
  expect(events.every((e: any) => e.type === "touch")).toBe(
    true,
  );
  expect(
    events.map((e: any) => e.contacts[0].phase),
  ).toEqual(["down", ...Array(21).fill("update"), "up"]);
  expect(fixture.control.resetInput).not.toHaveBeenCalled();
});

it.each(["", "Unidentified"])(
  "forwards IME keys with code '%s' and selection-only navigation repeatedly",
  (code) => {
    const { editor, keyboard } = renderKeyboardControl();
    keyboard()?.show();
    fixture.control.input.mockClear();
    for (const key of [
      "ArrowLeft",
      "ArrowRight",
      "ArrowRight",
    ]) {
      expect(fireEvent.keyDown(editor, { key, code })).toBe(
        false,
      );
    }
    for (const position of [0, 2, 2]) {
      editor.setSelectionRange(position, position);
      document.dispatchEvent(new Event("selectionchange"));
      expect(editor.selectionStart).toBe(1);
      document.dispatchEvent(new Event("selectionchange"));
    }
    expect(
      fixture.control.input.mock.calls.map(([e]: any[]) => [
        e.scanCode,
        e.down,
      ]),
    ).toEqual(
      [0x4b, 0x4d, 0x4d, 0x4b, 0x4d, 0x4d].flatMap(
        (code) => [
          [code, true],
          [code, false],
        ],
      ),
    );
    fixture.control.input.mockClear();
    fireEvent.compositionStart(editor);
    fireEvent.keyDown(editor, {
      key: "ArrowRight",
      code: "",
    });
    editor.setSelectionRange(2, 2);
    document.dispatchEvent(new Event("selectionchange"));
    expect(fixture.control.input).not.toHaveBeenCalled();
  },
);

it("keeps a pending Chinese commit alive through transient secure-context keyboard geometry", () => {
  vi.useFakeTimers();
  const api = Object.assign(new EventTarget(), {
    boundingRect: { height: 0 },
    show: vi.fn(),
    hide: vi.fn(),
  });
  Object.defineProperty(navigator, "virtualKeyboard", {
    configurable: true,
    value: api,
  });
  const [visible, setVisible] = createSignal(true);
  const [keyboard, setKeyboard] =
    createSignal<RemoteKeyboardInputHandle>();
  const enabled = () =>
    visible() || keyboard()?.focused() === true;
  render(() => (
    <RemoteKeyboardInput
      control={fixture.control}
      state="active"
      enabled={enabled()}
      registerKeyboard={(handle) => {
        setKeyboard(handle);
        return () => setKeyboard(undefined);
      }}
    />
  ));
  keyboard()?.show();
  const editor = screen.getByRole(
    "textbox",
  ) as HTMLTextAreaElement;
  setVisible(false);
  api.boundingRect.height = 300;
  api.dispatchEvent(new Event("geometrychange"));
  fireEvent.compositionStart(editor);
  editor.value = "\u200b中文\u200b";
  fireEvent.input(editor, {
    inputType: "insertCompositionText",
    isComposing: true,
  });
  fireEvent.compositionEnd(editor, { data: "中文" });
  api.boundingRect.height = 0;
  api.dispatchEvent(new Event("geometrychange"));
  expect(editor).toHaveFocus();
  expect(editor.isConnected).toBe(true);
  vi.advanceTimersByTime(50);
  expect(fixture.control.input).toHaveBeenLastCalledWith({
    type: "text",
    text: "中文",
  });
  api.boundingRect.height = 300;
  api.dispatchEvent(new Event("geometrychange"));
  vi.advanceTimersByTime(200);
  expect(editor).toHaveFocus();
  expect(api.show).not.toHaveBeenCalled();
  expect(api.hide).not.toHaveBeenCalled();
});

it("uses the shared exit shortcut to close explicit keyboard input without ending control", () => {
  const { editor, keyboard } = renderKeyboardControl();
  keyboard()?.show();
  fixture.control.resetInput.mockClear();
  fireEvent.keyDown(editor, {
    code: "KeyQ",
    key: "Q",
    ctrlKey: true,
    altKey: true,
    shiftKey: true,
  });
  expect(editor).not.toHaveFocus();
  expect(fixture.control.resetInput).toHaveBeenCalled();
  expect(fixture.control.cancel).not.toHaveBeenCalled();
});
