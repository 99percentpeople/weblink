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
  waitFor,
} from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { reconcile } from "solid-js/store";
import type { NativeKeyboardEvent } from "@weblink/platform";
import { RemoteControlOverlay } from "@/routes/home/components/remote-control-overlay";
import { RemoteKeyboardToggle } from "@/routes/home/components/remote-keyboard-toggle";
import RemoteControlSettings from "@/components/settings/remote-control-settings";
import { SettingsStateProvider } from "../helpers/settings-state";
import { platform } from "@/libs/platform/runtime";
import { createRemoteClipboard } from "@/libs/hooks/create-remote-clipboard";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

const fixture = vi.hoisted(() => ({
  control: undefined as any,
  video: undefined as any,
  error: vi.fn(),
  loading: vi.fn(() => "drop-toast"),
  dismiss: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: {
    error: fixture.error,
    loading: fixture.loading,
    dismiss: fixture.dismiss,
    success: fixture.success,
  },
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
  state = () => this.value;
  relative = true;
  supportsRelativePointer = () => this.relative;
  supportsKeyboard = () => true;
  supportsTouch = () => true;
  supportsTouchpadPan = () => true;
  position = () => ({ x: 0.5, y: 0.5 });
  trackpad = vi.fn();
  move = vi.fn();
  input = vi.fn(() => true);
  resetInput = vi.fn();
  setCursorVisible = vi.fn();
  cursorListener?: (
    shape:
      | import("@/libs/domain/protocol/remote-control/cursor").RemoteCursorShape
      | undefined,
  ) => void;
  watchCursor = vi.fn(
    (listener: NonNullable<Control["cursorListener"]>) => {
      this.cursorListener = listener;
      listener(undefined);
      return () => {
        this.cursorListener = undefined;
      };
    },
  );
  cancel = vi.fn();
}
let locked: Element | null;
let pending: HTMLElement | undefined;
let request: ReturnType<typeof vi.fn>;
let exit: ReturnType<typeof vi.fn>;
const nativeKeyboard = platform.keyboard;
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
  locked = null;
  pending = undefined;
  request = vi.fn(function (this: HTMLElement) {
    pending = this;
  });
  exit = vi.fn(() => {
    locked = null;
    fireEvent(document, new Event("pointerlockchange"));
  });
  Object.defineProperty(document, "pointerLockElement", {
    configurable: true,
    get: () => locked,
  });
  Object.assign(document, { exitPointerLock: exit });
  Object.defineProperty(document, "elementFromPoint", {
    configurable: true,
    value: vi.fn(() => screen.queryByRole("application")),
  });
  Object.assign(HTMLElement.prototype, {
    requestPointerLock: request,
    setPointerCapture() {},
    releasePointerCapture() {},
    hasPointerCapture: () => false,
  });
});
afterEach(() => {
  cleanup();
  Object.assign(platform, {
    keyboard: nativeKeyboard,
    kind: "browser",
  });
  Reflect.deleteProperty(document, "pointerLockElement");
  Reflect.deleteProperty(document, "exitPointerLock");
  Reflect.deleteProperty(document, "hidden");
  Reflect.deleteProperty(document, "elementFromPoint");
  Reflect.deleteProperty(
    HTMLElement.prototype,
    "requestPointerLock",
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const surface = () => screen.getByRole("application");
function mouse(phase: string, button = 0) {
  const event = new MouseEvent(`pointer${phase}`, {
    bubbles: true,
    cancelable: true,
    button,
    clientX: 100,
    clientY: 100,
  });
  Object.assign(event, {
    pointerType: "mouse",
    pointerId: 1,
  });
  fireEvent(surface(), event);
  if (phase === "down")
    fireEvent.mouseDown(surface(), {
      button,
      clientX: 100,
      clientY: 100,
    });
  if (phase === "up")
    fireEvent.mouseUp(surface(), {
      button,
      clientX: 100,
      clientY: 100,
    });
}
function click() {
  mouse("down");
  mouse("up");
  fireEvent.click(surface(), { button: 0, detail: 1 });
}
function grant() {
  locked = pending!;
  pending = undefined;
  fireEvent(document, new Event("pointerlockchange"));
}
function capture() {
  setAppState(
    "options",
    "remotePointer",
    "mode",
    "capture",
  );
  click();
  grant();
}
function key(code = "KeyA", modifiers = {}) {
  fireEvent.keyDown(surface(), {
    code,
    key: code,
    ...modifiers,
  });
}
const exitKeys = {
  ctrlKey: true,
  altKey: true,
  shiftKey: true,
};

it("captures dropped files synchronously and maps the remote position without clipboard APIs", async () => {
  setAppState("options", "remotePointer", "fileDrop", true);
  fixture.control.fileDropTarget = () => ({
    grantId: "grant",
    target: {
      sourceId: "source",
      mediaId: "media",
      geometryRevision: "layout",
    },
  });
  const file = new File(["bytes"], "file.txt");
  let readable = true;
  const getAsFile = vi.fn(() => {
    if (!readable) throw new Error("Expired drop data");
    return file;
  });
  const drop = vi.fn(
    async (_peer, _control, _point, read) => {
      expect(
        await read(
          new AbortController().signal,
          64 * 1024 * 1024,
        ),
      ).toEqual([file]);
    },
  );
  render(() => (
    <RemoteControlOverlay
      enabled
      clientId="peer"
      fileDrop={{ drop }}
    />
  ));
  const event = new MouseEvent("drop", {
    bubbles: true,
    cancelable: true,
    clientX: 100,
    clientY: 100,
  });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], items: [{ getAsFile }] },
  });
  fireEvent(surface(), event);
  readable = false;
  expect(event.defaultPrevented).toBe(true);
  expect(getAsFile).toHaveBeenCalledOnce();
  expect(drop).toHaveBeenCalledWith(
    "peer",
    fixture.control,
    { x: 0.5, y: 0.5 },
    expect.any(Function),
    expect.any(AbortSignal),
    expect.any(Function),
  );
  await waitFor(() =>
    expect(fixture.dismiss).toHaveBeenCalled(),
  );
  setAppState(
    "options",
    "remotePointer",
    "fileDrop",
    false,
  );
  fireEvent(surface(), event);
  expect(drop).toHaveBeenCalledOnce();
});

it("forwards absolute pointer input and focused keyboard input by default in local-cursor mode", () => {
  render(() => <RemoteControlOverlay enabled />);
  key();
  expect(fixture.control.input).not.toHaveBeenCalled();
  click();
  expect(request).not.toHaveBeenCalled();
  expect(
    fixture.control.input.mock.calls.map(([e]: any[]) => e),
  ).toEqual([
    {
      type: "button",
      x: 0.5,
      y: 0.5,
      button: 0,
      down: true,
    },
    {
      type: "button",
      x: 0.5,
      y: 0.5,
      button: 0,
      down: false,
    },
  ]);
  key();
  expect(fixture.control.input).toHaveBeenLastCalledWith({
    type: "key",
    scanCode: 0x1e,
    extended: false,
    down: true,
  });
  fireEvent.wheel(surface(), {
    clientX: 100,
    clientY: 100,
    deltaY: 20,
  });
  expect(fixture.control.input).toHaveBeenLastCalledWith({
    type: "wheel",
    x: 0.5,
    y: 0.5,
    horizontal: 0,
    vertical: -20,
  });
});
it.each(["local", "capture"] as const)(
  "reuses the input surface across control toggles without retaining input in %s mode",
  (mode) => {
    setAppState("options", "remotePointer", "mode", mode);
    render(() => <RemoteControlOverlay enabled />);
    const element = surface();
    if (mode === "capture") capture();
    else mouse("down");
    key();
    fixture.control.resetInput.mockClear();

    fixture.control.value = "viewing";
    fixture.control.dispatchEvent(new Event("change"));
    expect(element.isConnected).toBe(true);
    expect(screen.queryByRole("application")).toBeNull();
    expect(element.tabIndex).toBe(-1);
    expect(document.activeElement).not.toBe(element);
    expect(locked).toBeNull();
    expect(fixture.control.resetInput).toHaveBeenCalled();
    fixture.control.input.mockClear();
    fixture.control.move.mockClear();
    fixture.control.trackpad.mockClear();

    // Already queued events must not forward input through the inert surface.
    for (const phase of ["down", "move", "up"]) {
      const event = new MouseEvent(`pointer${phase}`, {
        bubbles: true,
        clientX: 100,
        clientY: 100,
        button: 0,
      });
      Object.assign(event, {
        pointerType: "mouse",
        pointerId: 1,
      });
      fireEvent(element, event);
    }
    fireEvent.keyDown(element, { code: "KeyA", key: "a" });
    fireEvent.wheel(element, {
      clientX: 100,
      clientY: 100,
      deltaY: 20,
    });
    fireEvent.click(element);
    expect(fixture.control.input).not.toHaveBeenCalled();
    expect(fixture.control.move).not.toHaveBeenCalled();
    expect(fixture.control.trackpad).not.toHaveBeenCalled();

    fixture.control.value = "active";
    fixture.control.dispatchEvent(new Event("change"));
    expect(surface()).toBe(element);
    expect(element.tabIndex).toBe(0);
    key();
    expect(fixture.control.input).not.toHaveBeenCalled();
    if (mode === "capture") capture();
    else click();
    key();
    expect(fixture.control.input).toHaveBeenLastCalledWith({
      type: "key",
      scanCode: 0x1e,
      extended: false,
      down: true,
    });
  },
);
it("does not let an inactive mirror restore the active surface's cursor", () => {
  const [mirror, setMirror] = createSignal(false);
  render(() => (
    <>
      <RemoteControlOverlay enabled />
      <Show when={mirror()}>
        <RemoteControlOverlay enabled={false} />
      </Show>
    </>
  ));
  mouse("move");
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(false);
  fixture.control.setCursorVisible.mockClear();
  setMirror(true);
  setMirror(false);
  expect(
    fixture.control.setCursorVisible,
  ).not.toHaveBeenCalled();
});
it("hides the host cursor only over video content with a local mouse", () => {
  render(() => <RemoteControlOverlay enabled />);
  mouse("move");
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(false);
  const letterbox = new MouseEvent("pointermove", {
    bubbles: true,
    clientX: 100,
    clientY: 10,
  });
  Object.assign(letterbox, { pointerType: "mouse" });
  fireEvent(surface(), letterbox);
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(true);
  mouse("move");
  fireEvent.pointerLeave(surface());
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(true);
  mouse("move");
  const touch = new MouseEvent("pointermove", {
    bubbles: true,
    clientX: 100,
    clientY: 100,
  });
  Object.assign(touch, { pointerType: "touch" });
  fireEvent(surface(), touch);
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(true);
});
it.each([
  "blur",
  "hidden",
  "disabled",
  "revoked",
  "unmount",
])("restores the host cursor on %s", (reason) => {
  const [enabled, setEnabled] = createSignal(true);
  const view = render(() => (
    <RemoteControlOverlay enabled={enabled()} />
  ));
  mouse("move");
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(false);
  if (reason === "blur")
    fireEvent(window, new Event("blur"));
  if (reason === "hidden") {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      value: true,
    });
    fireEvent(document, new Event("visibilitychange"));
  }
  if (reason === "disabled") setEnabled(false);
  if (reason === "revoked") {
    fixture.control.value = "viewing";
    fixture.control.dispatchEvent(new Event("change"));
  }
  if (reason === "unmount") view.unmount();
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(true);
});
it("keeps the host cursor visible before, during and after pointer capture", () => {
  render(() => <RemoteControlOverlay enabled />);
  mouse("move");
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(false);
  setAppState(
    "options",
    "remotePointer",
    "mode",
    "capture",
  );
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(true);
  fixture.control.setCursorVisible.mockClear();
  mouse("move");
  capture();
  mouse("move");
  key("KeyQ", exitKeys);
  expect(
    fixture.control.setCursorVisible.mock.calls.every(
      ([visible]: boolean[]) => visible,
    ),
  ).toBe(true);
});
it("keeps the remote cursor hidden and the button held when dragging beyond the video", () => {
  render(() => <RemoteControlOverlay enabled />);
  mouse("down");
  fixture.control.resetInput.mockClear();
  const drag = (phase: string) => {
    const event = new MouseEvent(`pointer${phase}`, {
      bubbles: true,
      cancelable: true,
      clientX: 250,
      clientY: 20,
      button: 0,
    });
    Object.assign(event, {
      pointerType: "mouse",
      pointerId: 1,
    });
    fireEvent(surface(), event);
  };
  drag("move");
  fireEvent.pointerLeave(surface());
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(false);
  expect(fixture.control.move).toHaveBeenLastCalledWith({
    x: 1,
    y: 0,
  });
  expect(fixture.control.resetInput).not.toHaveBeenCalled();
  drag("up");
  expect(fixture.control.input).toHaveBeenLastCalledWith({
    type: "button",
    x: 1,
    y: 0,
    button: 0,
    down: false,
  });
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(true);
  expect(fixture.control.resetInput).not.toHaveBeenCalled();
});
it("does not flash the remote cursor when a captured drag ends back inside the video", () => {
  render(() => <RemoteControlOverlay enabled />);
  mouse("down");
  fireEvent.pointerLeave(surface());
  fixture.control.setCursorVisible.mockClear();
  mouse("up");
  expect(
    fixture.control.setCursorVisible.mock.calls.every(
      ([visible]: boolean[]) => !visible,
    ),
  ).toBe(true);
  fireEvent.pointerLeave(surface());
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(true);
});
it("restores the remote cursor if a drag loses pointer capture outside the video", () => {
  render(() => <RemoteControlOverlay enabled />);
  mouse("down");
  fireEvent.pointerLeave(surface());
  fixture.control.resetInput.mockClear();
  fireEvent.lostPointerCapture(surface(), { pointerId: 1 });
  expect(fixture.control.resetInput).toHaveBeenCalledOnce();
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(true);
});
it.each(["fullscreenchange", "resize"])(
  "rechecks a stationary mouse after %s changes the control surface",
  async (event) => {
    render(() => <RemoteControlOverlay enabled />);
    mouse("move");
    fireEvent.pointerLeave(surface());
    expect(
      fixture.control.setCursorVisible,
    ).toHaveBeenLastCalledWith(true);
    const toolbar = document.createElement("button");
    document.body.append(toolbar);
    const movement = new MouseEvent("pointermove", {
      bubbles: true,
      clientX: 100,
      clientY: 100,
    });
    Object.assign(movement, { pointerType: "mouse" });
    fireEvent(toolbar, movement);
    fireEvent(
      event === "resize" ? window : document,
      new Event(event),
    );
    await waitFor(() =>
      expect(
        fixture.control.setCursorVisible,
      ).toHaveBeenLastCalledWith(false),
    );
    vi.mocked(document.elementFromPoint).mockReturnValue(
      toolbar,
    );
    fireEvent(
      event === "resize" ? window : document,
      new Event(event),
    );
    await waitFor(() =>
      expect(
        fixture.control.setCursorVisible,
      ).toHaveBeenLastCalledWith(true),
    );
    toolbar.remove();
  },
);
it("does not rehide the cursor when a pending fullscreen refresh runs after window blur", async () => {
  render(() => <RemoteControlOverlay enabled />);
  mouse("move");
  fireEvent(document, new Event("fullscreenchange"));
  fireEvent(window, new Event("blur"));
  await waitFor(() =>
    expect(document.elementFromPoint).toHaveBeenCalled(),
  );
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(true);
});
it("waits for a successful capture before enabling pointer and physical keyboard input", () => {
  setAppState(
    "options",
    "remotePointer",
    "mode",
    "capture",
  );
  render(() => <RemoteControlOverlay enabled />);
  click();
  key();
  mouse("move");
  fireEvent.wheel(surface(), { deltaY: 20 });
  expect(request).toHaveBeenCalledOnce();
  expect(fixture.control.input).not.toHaveBeenCalled();
  expect(fixture.control.trackpad).not.toHaveBeenCalled();
  expect(fixture.control.move).not.toHaveBeenCalled();
  grant();
  key();
  expect(fixture.control.input).toHaveBeenCalledOnce();
  expect(fixture.control.input).toHaveBeenLastCalledWith({
    type: "key",
    scanCode: 0x1e,
    extended: false,
    down: true,
  });
  // Lock movement must not use the frozen absolute event coordinates, or be doubled by pointermove.
  mouse("move");
  const movement = new MouseEvent("mousemove", {
    bubbles: true,
  });
  Object.assign(movement, {
    movementX: 20,
    movementY: -10,
  });
  fireEvent(surface(), movement);
  expect(fixture.control.trackpad).toHaveBeenCalledWith({
    type: "move",
    x: 0.1,
    y: -0.1,
  });
  mouse("down", 2);
  mouse("up", 2);
  fireEvent.wheel(surface(), {
    deltaX: 1,
    deltaY: 2,
    deltaMode: 1,
  });
  expect(
    fixture.control.trackpad.mock.calls
      .slice(1)
      .map(([e]: any[]) => e),
  ).toEqual([
    { type: "button", button: 2, down: true },
    { type: "button", button: 2, down: false },
    { type: "wheel", horizontal: 40, vertical: -80 },
  ]);
  expect(fixture.control.move).not.toHaveBeenCalled();
});
it.each(["ctrl-alt-shift-q", "ctrl-alt-shift-x"] as const)(
  "shares %s to release capture and held input without cancelling the grant",
  (shortcut) => {
    setAppState(
      "options",
      "remoteKeyboard",
      "exitShortcut",
      shortcut,
    );
    render(() => <RemoteControlOverlay enabled />);
    capture();
    key();
    mouse("down");
    fixture.control.resetInput.mockClear();
    key(shortcut.endsWith("q") ? "KeyQ" : "KeyX", exitKeys);
    expect(locked).toBeNull();
    expect(
      fixture.control.resetInput,
    ).toHaveBeenCalledOnce();
    expect(fixture.control.cancel).not.toHaveBeenCalled();
    fixture.control.input.mockClear();
    key();
    expect(fixture.control.input).not.toHaveBeenCalled();
    click();
    grant();
    key();
    expect(fixture.control.input).toHaveBeenCalledOnce();
  },
);
it("keeps the release shortcut available with keyboard forwarding disabled", () => {
  setAppState(
    "options",
    "remoteKeyboard",
    "enabled",
    false,
  );
  render(() => <RemoteControlOverlay enabled />);
  capture();
  key();
  expect(fixture.control.input).not.toHaveBeenCalled();
  key("KeyQ", exitKeys);
  expect(locked).toBeNull();
  expect(fixture.control.cancel).not.toHaveBeenCalled();
});
it.each([
  "browser",
  "blur",
  "hidden",
  "mode",
  "disabled",
  "revoked",
  "unmount",
])(
  "releases all held input after %s and never resumes capture automatically",
  (reason) => {
    const [enabled, setEnabled] = createSignal(true);
    const view = render(() => (
      <RemoteControlOverlay enabled={enabled()} />
    ));
    capture();
    key();
    mouse("down");
    fixture.control.resetInput.mockClear();
    if (reason === "browser") {
      locked = null;
      fireEvent(document, new Event("pointerlockchange"));
    }
    if (reason === "blur")
      fireEvent(window, new Event("blur"));
    if (reason === "hidden") {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        value: true,
      });
      fireEvent(document, new Event("visibilitychange"));
    }
    if (reason === "mode")
      setAppState(
        "options",
        "remotePointer",
        "mode",
        "local",
      );
    if (reason === "disabled") setEnabled(false);
    if (reason === "revoked") {
      fixture.control.value = "idle";
      fixture.control.dispatchEvent(new Event("change"));
    }
    if (reason === "unmount") view.unmount();
    expect(locked).toBeNull();
    expect(fixture.control.resetInput).toHaveBeenCalled();
    expect(fixture.control.cancel).not.toHaveBeenCalled();
    fireEvent(window, new Event("focus"));
    expect(request).toHaveBeenCalledOnce();
  },
);
it.each(["mode", "blur", "unmount"])(
  "releases a late capture after %s without activating the keyboard",
  (reason) => {
    setAppState(
      "options",
      "remotePointer",
      "mode",
      "capture",
    );
    const view = render(() => (
      <RemoteControlOverlay enabled />
    ));
    click();
    if (reason === "mode")
      setAppState(
        "options",
        "remotePointer",
        "mode",
        "local",
      );
    if (reason === "blur")
      fireEvent(window, new Event("blur"));
    if (reason === "unmount") view.unmount();
    grant();
    expect(locked).toBeNull();
    expect(fixture.control.input).not.toHaveBeenCalled();
  },
);
it("reports a rejected capture once, leaves keys local and allows a fresh attempt", async () => {
  request.mockImplementationOnce(() =>
    Promise.reject(new Error("denied")),
  );
  setAppState(
    "options",
    "remotePointer",
    "mode",
    "capture",
  );
  render(() => <RemoteControlOverlay enabled />);
  click();
  fireEvent(document, new Event("pointerlockerror"));
  await Promise.resolve();
  key();
  expect(fixture.error).toHaveBeenCalledOnce();
  expect(fixture.error).toHaveBeenCalledWith(
    "remote_control.capture_failed",
  );
  expect(fixture.control.input).not.toHaveBeenCalled();
  click();
  grant();
  key();
  expect(fixture.control.input).toHaveBeenCalledOnce();
});
it("does not steal a lock from a different element or capture an unsupported host", () => {
  render(() => <RemoteControlOverlay enabled />);
  setAppState(
    "options",
    "remotePointer",
    "mode",
    "capture",
  );
  locked = document.body;
  click();
  expect(request).not.toHaveBeenCalled();
  expect(exit).not.toHaveBeenCalled();
  locked = null;
  fixture.control.relative = false;
  click();
  expect(fixture.error).toHaveBeenLastCalledWith(
    "remote_control.capture_unavailable",
  );
  expect(request).not.toHaveBeenCalled();
});
it.each(["local", "capture"] as const)(
  "owns native keyboard input through focus/capture and releases on exit in %s mode",
  async (mode) => {
    setAppState("options", "remotePointer", "mode", mode);
    let receive!: (event: NativeKeyboardEvent) => void;
    const close = vi.fn(async () => {});
    const start = vi.fn(async (_shortcut, listener) => {
      receive = listener;
      return { close, renew: vi.fn(async () => {}) };
    });
    Object.assign(platform, {
      keyboard: { supported: async () => true, start },
    });
    render(() => <RemoteControlOverlay enabled />);
    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    surface().focus();
    if (mode === "capture") {
      click();
      expect(start).not.toHaveBeenCalled();
      grant();
    }
    await Promise.resolve();
    expect(start).toHaveBeenCalledOnce();
    fixture.control.input.mockClear();
    key();
    expect(fixture.control.input).not.toHaveBeenCalled();
    receive({
      type: "key",
      sequence: 1,
      timestamp: Date.now(),
      scanCode: 0x1e,
      extended: false,
      down: true,
    });
    receive({ type: "stopped", reason: "exit" });
    expect(locked).toBeNull();
    expect(close).toHaveBeenCalledOnce();
    expect(fixture.control.cancel).not.toHaveBeenCalled();
    expect(fixture.control.input).toHaveBeenLastCalledWith({
      type: "key",
      scanCode: 0x1e,
      extended: false,
      down: false,
    });
  },
);
it.each([false, true])(
  "gates clipboard file destination by actual binary write support (%s)",
  async (supported) => {
    const browserNavigator = navigator;
    vi.stubGlobal(
      "navigator",
      new Proxy(browserNavigator, {
        get: (target, name) =>
          name === "clipboard"
            ? { write: vi.fn() }
            : Reflect.get(target, name, target),
      }),
    );
    vi.stubGlobal("isSecureContext", false);
    vi.stubGlobal(
      "ClipboardItem",
      class {
        static supports = () => supported;
      },
    );
    setAppState(
      "options",
      "remoteKeyboard",
      "clipboardFiles",
      "cache",
    );
    render(() => (
      <SettingsStateProvider>
        <RemoteControlSettings />
      </SettingsStateProvider>
    ));
    const select = screen.getByRole("button", {
      name: /setting.remote_control.clipboard_files.title/,
    });
    expect(select).toBeDisabled();
    fireEvent.click(
      screen.getByRole("switch", {
        name: "setting.remote_control.clipboard.title",
      }),
    );
    await vi.waitFor(() => expect(select).toBeEnabled());
    fireEvent.keyDown(select, { key: "ArrowDown" });
    const clipboard = await screen.findByRole("option", {
      name: "setting.remote_control.clipboard_files.clipboard",
    });
    expect(
      clipboard.getAttribute("aria-disabled") === "true",
    ).toBe(!supported);
    if (supported) fireEvent.click(clipboard);
    else
      fireEvent.click(
        screen.getByRole("option", {
          name: "setting.remote_control.clipboard_files.off",
        }),
      );
    expect(
      appState.options.remoteKeyboard.clipboardFiles,
    ).toBe(supported ? "clipboard" : "off");
  },
);
it("updates clipboard file availability when browser write permission changes", async () => {
  const permission = Object.assign(new EventTarget(), {
    state: "granted",
  });
  const browserNavigator = navigator;
  vi.stubGlobal(
    "navigator",
    new Proxy(browserNavigator, {
      get: (target, name) =>
        name === "clipboard"
          ? { write: vi.fn() }
          : name === "permissions"
            ? { query: async () => permission }
            : Reflect.get(target, name, target),
    }),
  );
  vi.stubGlobal(
    "ClipboardItem",
    class {
      static supports = () => true;
    },
  );
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboard",
    true,
  );
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboardFiles",
    "cache",
  );
  render(() => (
    <SettingsStateProvider>
      <RemoteControlSettings />
    </SettingsStateProvider>
  ));
  const select = screen.getByRole("button", {
    name: /setting.remote_control.clipboard_files.title/,
  });
  await vi.waitFor(() => expect(select).toBeEnabled());
  permission.state = "denied";
  permission.dispatchEvent(new Event("change"));
  fireEvent.keyDown(select, { key: "ArrowDown" });
  expect(
    await screen.findByRole("option", {
      name: "setting.remote_control.clipboard_files.clipboard",
    }),
  ).toHaveAttribute("aria-disabled", "true");
  fireEvent.click(
    screen.getByRole("option", {
      name: "setting.remote_control.clipboard_files.off",
    }),
  );
  permission.state = "granted";
  permission.dispatchEvent(new Event("change"));
  fireEvent.keyDown(select, { key: "ArrowDown" });
  expect(
    (
      await screen.findByRole("option", {
        name: "setting.remote_control.clipboard_files.clipboard",
      })
    ).getAttribute("aria-disabled"),
  ).not.toBe("true");
});
it("shares native discovery and permission observers across settings and repeated remote input mounts", async () => {
  const permission = Object.assign(new EventTarget(), {
    state: "granted",
  });
  const query = vi.fn(
    async (_request: { name: string }) => permission,
  );
  const listen = vi.spyOn(permission, "addEventListener");
  const browserNavigator = navigator;
  vi.stubGlobal(
    "navigator",
    new Proxy(browserNavigator, {
      get: (target, name) =>
        name === "permissions"
          ? { query }
          : Reflect.get(target, name, target),
    }),
  );
  Object.assign(platform, { kind: "desktop" });
  const previous = platform.clipboard;
  platform.clipboard = {
    read: vi.fn(),
    write: vi.fn(),
  } as any;
  const discovery = vi
    .spyOn(platform, "getCapabilities")
    .mockResolvedValue({
      runtime: "desktop",
      os: "windows",
      version: null,
      nativeScreenCapture: false,
      displayRefreshRates: [],
      remoteInput: true,
      nativeClipboard: true,
    });
  const [open, setOpen] = createSignal(false);
  const clipboard = {
    copy: vi.fn(),
    paste: vi.fn(),
    watch: vi.fn(() => () => {}),
  };
  Object.assign(fixture.control, {
    clipboardGrant: () => "grant",
  });
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboard",
    true,
  );
  const Consumer = () => {
    const actions = createRemoteClipboard({
      clientId: "peer",
      control: fixture.control,
      state: "active",
      enabled: true,
      clipboard,
    });
    return (
      <span data-testid="clipboard-consumer">
        {String(actions.canCopy())}
      </span>
    );
  };
  try {
    render(() => (
      <SettingsStateProvider>
        <Show when={open()}>
          <RemoteControlSettings />
          <Consumer />
          <Consumer />
        </Show>
      </SettingsStateProvider>
    ));
    await waitFor(() =>
      expect(appState.capabilities.clipboard.ready).toBe(
        true,
      ),
    );
    expect(
      appState.options.remoteKeyboard.clipboardFiles,
    ).toBe("clipboard");
    setOpen(true);
    expect(
      screen
        .getAllByTestId("clipboard-consumer")
        .every((element) => element.textContent === "true"),
    ).toBe(true);
    setOpen(false);
    setOpen(true);
    expect(
      screen.getByRole("button", {
        name: /setting.remote_control.clipboard_files.title/,
      }),
    ).toHaveTextContent(
      "setting.remote_control.clipboard_files.clipboard",
    );
    expect(discovery).toHaveBeenCalledOnce();
    expect(
      query.mock.calls
        .map(([request]) => request.name)
        .sort(),
    ).toEqual(["clipboard-read", "clipboard-write"]);
    expect(listen).toHaveBeenCalledTimes(2);
    expect(platform.clipboard!.read).not.toHaveBeenCalled();
    expect(
      platform.clipboard!.write,
    ).not.toHaveBeenCalled();
  } finally {
    platform.clipboard = previous;
  }
});
it("waits for initial permission detection before selecting File cache in settings", async () => {
  let resolve!: (permission: { state: string }) => void;
  const pending = new Promise<{ state: string }>((done) => {
    resolve = done;
  });
  const browserNavigator = navigator;
  vi.stubGlobal(
    "navigator",
    new Proxy(browserNavigator, {
      get: (target, name) =>
        name === "clipboard"
          ? { write: vi.fn() }
          : name === "permissions"
            ? { query: () => pending }
            : Reflect.get(target, name, target),
    }),
  );
  vi.stubGlobal(
    "ClipboardItem",
    class {
      static supports = () => true;
    },
  );
  setAppState(
    "options",
    "remoteKeyboard",
    "clipboard",
    true,
  );
  render(() => (
    <SettingsStateProvider>
      <RemoteControlSettings />
    </SettingsStateProvider>
  ));
  const select = screen.getByRole("button", {
    name: /setting.remote_control.clipboard_files.title/,
  });
  expect(select).toBeDisabled();
  expect(select).toHaveTextContent(
    "setting.remote_control.clipboard_files.loading",
  );
  expect(
    appState.options.remoteKeyboard.clipboardFiles,
  ).toBeUndefined();
  resolve(
    Object.assign(new EventTarget(), { state: "denied" }),
  );
  await waitFor(() => expect(select).toBeEnabled());
  expect(select).toHaveTextContent(
    "setting.remote_control.clipboard_files.cache",
  );
  expect(
    appState.options.remoteKeyboard.clipboardFiles,
  ).toBe("cache");
});
it("provides both pointer behaviors in Remote control settings", async () => {
  render(() => (
    <SettingsStateProvider>
      <RemoteControlSettings />
    </SettingsStateProvider>
  ));
  const select = screen.getByRole("button", {
    name: /setting.remote_control.pointer.title/,
  });
  fireEvent.keyDown(select, { key: "ArrowDown" });
  fireEvent.click(
    await screen.findByRole("option", {
      name: "setting.remote_control.pointer.capture",
    }),
  );
  expect(appState.options.remotePointer.mode).toBe(
    "capture",
  );
});

it("shows browser release help without Windows-only shortcuts", () => {
  render(() => (
    <SettingsStateProvider>
      <RemoteControlSettings />
    </SettingsStateProvider>
  ));
  expect(
    screen.getByText(/exit_shortcut.browser/),
  ).toBeVisible();
  expect(
    screen.queryByText(
      /exit_shortcut.native|emergency_shortcut.title/,
    ),
  ).toBeNull();
  expect(
    screen.queryByRole("switch", {
      name: "setting.remote_control.system_keyboard.title",
    }),
  ).toBeNull();
});
it("adapts Windows release help to native keyboard support and forwarding settings", async () => {
  Object.assign(platform, {
    kind: "desktop",
    keyboard: {
      supported: async () => true,
      start: vi.fn(),
    },
  });
  vi.spyOn(platform, "getCapabilities").mockResolvedValue({
    runtime: "desktop",
    os: "windows",
    version: null,
    nativeScreenCapture: true,
    displayRefreshRates: [],
    remoteInput: true,
    systemKeyboard: true,
  });
  render(() => (
    <SettingsStateProvider>
      <RemoteControlSettings />
    </SettingsStateProvider>
  ));
  expect(
    await screen.findByText(/exit_shortcut.native/),
  ).toBeVisible();
  expect(
    screen.getByText(/emergency_shortcut.title/),
  ).toBeVisible();
  expect(
    screen.queryByText(
      /exit_shortcut.browser|exit_shortcut.webview/,
    ),
  ).toBeNull();
  const previous = platform.remoteControl;
  const configureShortcut = vi.fn(
    async (_shortcut: string) => {},
  );
  Object.assign(platform, {
    remoteControl: { ...previous!, configureShortcut },
  });
  try {
    const button = screen.getByLabelText(
      "setting.remote_control.emergency_shortcut.title",
    );
    const record = (code: string) => {
      button.focus();
      fireEvent.click(button);
      fireEvent.keyDown(button, {
        code,
        ctrlKey: true,
        altKey: true,
      });
      fireEvent.keyUp(button, { code });
    };
    record("F8");
    await waitFor(() =>
      expect(
        appState.options.remoteKeyboard.emergencyShortcut,
      ).toBe("ctrl-alt-f8"),
    );
    expect(configureShortcut).toHaveBeenLastCalledWith(
      "ctrl-alt-f8",
    );
    configureShortcut.mockRejectedValueOnce(
      new Error("in use"),
    );
    record("F9");
    expect(
      await screen.findByRole("alert"),
    ).toHaveTextContent("emergency_shortcut.failed");
    expect(
      appState.options.remoteKeyboard.emergencyShortcut,
    ).toBe("ctrl-alt-f8");
  } finally {
    Object.assign(platform, { remoteControl: previous });
  }
  setAppState(
    "options",
    "remoteKeyboard",
    "systemKeys",
    false,
  );
  expect(
    screen.getByText(/exit_shortcut.webview/),
  ).toBeVisible();
  expect(
    screen.queryByText(/exit_shortcut.native/),
  ).toBeNull();
  setAppState(
    "options",
    "remoteKeyboard",
    "systemKeys",
    true,
  );
  setAppState(
    "options",
    "remoteKeyboard",
    "enabled",
    false,
  );
  expect(
    screen.getByText(/exit_shortcut.webview/),
  ).toBeVisible();
});

it("lets the header switch immediately disable and restore ordinary-mode keyboard forwarding", () => {
  render(() => (
    <>
      <RemoteKeyboardToggle controls={[fixture.control]} />
      <RemoteControlOverlay enabled />
    </>
  ));
  click();
  key();
  fixture.control.input.mockClear();
  const toggle = screen.getByRole("switch", {
    name: "remote_control.keyboard_control",
  });
  expect(toggle).toBeChecked();
  fireEvent.click(toggle);
  expect(toggle).not.toBeChecked();
  expect(fixture.control.input).toHaveBeenLastCalledWith({
    type: "key",
    scanCode: 0x1e,
    extended: false,
    down: false,
  });
  fixture.control.input.mockClear();
  key();
  expect(fixture.control.input).not.toHaveBeenCalled();
  fireEvent.click(toggle);
  key();
  expect(fixture.control.input).toHaveBeenCalledOnce();
});
it("releases ordinary-mode keyboard focus with the shared shortcut without ending control", () => {
  render(() => <RemoteControlOverlay enabled />);
  click();
  key();
  fixture.control.resetInput.mockClear();
  key("KeyQ", exitKeys);
  expect(surface()).not.toHaveFocus();
  expect(fixture.control.resetInput).toHaveBeenCalledOnce();
  expect(fixture.control.cancel).not.toHaveBeenCalled();
  fixture.control.input.mockClear();
  key();
  expect(fixture.control.input).not.toHaveBeenCalled();
  click();
  fixture.control.input.mockClear();
  key();
  expect(fixture.control.input).toHaveBeenCalledOnce();
});

it("stores one shared file size limit without changing either feature switch", () => {
  render(() => (
    <SettingsStateProvider>
      <RemoteControlSettings />
    </SettingsStateProvider>
  ));
  const input = screen.getByRole("spinbutton", {
    name: "setting.remote_control.file_size_limit.title",
  });
  expect(input).toHaveValue(64);
  fireEvent.change(input, { target: { value: "128" } });
  expect(appState.options.remoteFileMaxSize).toBe(
    128 * 1024 * 1024,
  );
  expect(appState.options.remotePointer.fileDrop).toBe(
    false,
  );
  expect(appState.options.remoteKeyboard.clipboard).toBe(
    false,
  );
  fireEvent.change(input, { target: { value: "0" } });
  expect(input).toHaveValue(1);
  fireEvent.change(input, { target: { value: "999" } });
  expect(input).toHaveValue(512);
  fireEvent.change(input, { target: { value: "" } });
  expect(input).toHaveValue(512);
  expect(appState.options.remoteFileMaxSize).toBe(
    512 * 1024 * 1024,
  );
});
it("persists cursor, clipboard and file drop switches independently", () => {
  render(() => (
    <SettingsStateProvider>
      <RemoteControlSettings />
    </SettingsStateProvider>
  ));
  const cursor = screen.getByRole("switch", {
    name: "setting.remote_control.cursor_sync.title",
  });
  const clipboard = screen.getByRole("switch", {
    name: "setting.remote_control.clipboard.title",
  });
  const drop = screen.getByRole("switch", {
    name: "setting.remote_control.file_drop.title",
  });
  expect(drop).not.toBeChecked();
  expect(cursor).toBeChecked();
  expect(clipboard).not.toBeChecked();
  expect(
    screen.getByRole("heading", {
      name: "setting.remote_control.general_heading",
    }),
  ).toBeInTheDocument();
  fireEvent.click(cursor);
  fireEvent.click(clipboard);
  fireEvent.click(drop);
  expect(appState.options.remotePointer.fileDrop).toBe(
    true,
  );
  fireEvent.click(clipboard);
  expect(drop).toBeChecked();
  fireEvent.click(clipboard);
  expect(appState.options.remotePointer.syncCursor).toBe(
    false,
  );
  expect(appState.options.remoteKeyboard.clipboard).toBe(
    true,
  );
});
it("stops cursor synchronization immediately when the setting is disabled", () => {
  render(() => <RemoteControlOverlay enabled />);
  mouse("move");
  expect(fixture.control.cursorListener).toBeTypeOf(
    "function",
  );
  fixture.control.cursorListener({
    type: "system",
    name: "text",
  });
  expect(surface().style.cursor).toBe("text");
  setAppState(
    "options",
    "remotePointer",
    "syncCursor",
    false,
  );
  expect(fixture.control.cursorListener).toBeUndefined();
  expect(surface().style.cursor).toBe("default");
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(false);
  setAppState(
    "options",
    "remotePointer",
    "syncCursor",
    true,
  );
  expect(fixture.control.cursorListener).toBeTypeOf(
    "function",
  );
  mouse("leave");
  expect(fixture.control.cursorListener).toBeUndefined();
  expect(
    fixture.control.setCursorVisible,
  ).toHaveBeenLastCalledWith(true);
});
