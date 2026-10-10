// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot } from "solid-js";
import { reconcile } from "solid-js/store";
import {
  isKeyboardEvidence,
  isMobileInputDevice,
} from "@/libs/domain/remote-control/local-input";
import { createAppLocalInput } from "@/libs/state/create-app-local-input";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

const disposers: (() => void)[] = [];
beforeEach(() =>
  setAppState(reconcile(createInitialAppState())),
);
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture() {
  return createRoot((dispose) => {
    disposers.push(dispose);
    createAppLocalInput();
    return dispose;
  });
}
function pad(connected = true, mapping = "standard") {
  return { connected, mapping } as Gamepad;
}
function gamepads() {
  const read = vi.fn<() => (Gamepad | null)[]>(() => []);
  vi.stubGlobal(
    "navigator",
    Object.assign(Object.create(navigator), {
      getGamepads: read,
    }),
  );
  return read;
}

it("discovers connected standard gamepads independently of forwarding and refreshes after reconnect/focus", () => {
  const read = gamepads();
  read.mockReturnValue([
    pad(),
    null,
    pad(false),
    pad(true, ""),
  ]);
  setAppState("options", "remoteGamepad", "enabled", false);
  fixture();
  expect(
    appState.capabilities.localInput.gamepadCount,
  ).toBe(1);
  read.mockReturnValue([pad(), pad()]);
  window.dispatchEvent(new Event("gamepadconnected"));
  expect(
    appState.capabilities.localInput.gamepadCount,
  ).toBe(2);
  read.mockReturnValue([]);
  window.dispatchEvent(new Event("gamepaddisconnected"));
  expect(
    appState.capabilities.localInput.gamepadCount,
  ).toBe(0);
  read.mockReturnValue([pad()]);
  window.dispatchEvent(new Event("focus"));
  expect(
    appState.capabilities.localInput.gamepadCount,
  ).toBe(1);
  expect(appState.options.remoteGamepad.enabled).toBe(
    false,
  );
});

it("handles denied API access and removes discovery listeners at app disposal", () => {
  const read = gamepads();
  read.mockImplementation(() => {
    throw new DOMException("Denied", "SecurityError");
  });
  const dispose = fixture();
  expect(
    appState.capabilities.localInput.gamepadCount,
  ).toBe(0);
  read.mockReturnValue([pad()]);
  window.dispatchEvent(new Event("focus"));
  expect(
    appState.capabilities.localInput.gamepadCount,
  ).toBe(1);
  dispose();
  read.mockClear();
  window.dispatchEvent(new Event("gamepadconnected"));
  window.dispatchEvent(new Event("gamepaddisconnected"));
  window.dispatchEvent(new Event("focus"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(read).not.toHaveBeenCalled();
});

it("observes gamepads in picture-in-picture and cleans up its window listeners", () => {
  const read = gamepads();
  const pip = new EventTarget();
  Object.defineProperty(
    window,
    "documentPictureInPicture",
    { configurable: true, value: pip },
  );
  const frame = document.createElement("iframe");
  document.body.append(frame);
  const view = frame.contentWindow!;
  const pipRead = vi.fn(() => [pad()]);
  Object.defineProperty(view.navigator, "getGamepads", {
    configurable: true,
    value: pipRead,
  });
  const dispose = fixture();
  try {
    pip.dispatchEvent(
      Object.assign(new Event("enter"), { window: view }),
    );
    expect(
      appState.capabilities.localInput.gamepadCount,
    ).toBe(1);
    pipRead.mockReturnValue([]);
    view.dispatchEvent(new Event("gamepaddisconnected"));
    expect(
      appState.capabilities.localInput.gamepadCount,
    ).toBe(0);
    view.dispatchEvent(new Event("pagehide"));
    pipRead.mockClear();
    view.dispatchEvent(new Event("focus"));
    expect(pipRead).not.toHaveBeenCalled();
    dispose();
    read.mockClear();
    window.dispatchEvent(new Event("focus"));
    expect(read).not.toHaveBeenCalled();
  } finally {
    Reflect.deleteProperty(
      window,
      "documentPictureInPicture",
    );
    frame.remove();
  }
});

it.each([
  [
    "Mozilla/5.0 (Linux; Android 15)",
    "Linux armv8l",
    5,
    true,
  ],
  ["Mozilla/5.0 (iPhone)", "iPhone", 5, true],
  ["Mozilla/5.0 (Macintosh)", "MacIntel", 5, true],
  ["Mozilla/5.0 (Macintosh)", "MacIntel", 0, false],
  ["Mozilla/5.0 (Windows NT 10.0)", "Win32", 10, false],
])(
  "classifies device type without using screen size: %s",
  (userAgent, platform, maxTouchPoints, mobile) => {
    expect(
      isMobileInputDevice({
        userAgent,
        platform,
        maxTouchPoints,
      }),
    ).toBe(mobile);
  },
);

const physical = {
  isTrusted: true,
  isComposing: false,
  keyCode: 65,
  key: "a",
  code: "KeyA",
};
it("only considers supported, trusted key use outside editors as keyboard evidence", () => {
  expect(isKeyboardEvidence(physical, false)).toBe(true);
  expect(isKeyboardEvidence(physical, true)).toBe(false);
  for (const change of [
    { isTrusted: false },
    { isComposing: true },
    { keyCode: 229 },
    { key: "Process" },
    { code: "" },
    { code: "AudioVolumeUp" },
  ])
    expect(
      isKeyboardEvidence({ ...physical, ...change }, false),
    ).toBe(false);
});

it("records mobile keyboard use globally without changing the saved forwarding preference", () => {
  setAppState("capabilities", "localInput", "mobile", true);
  setAppState(
    "options",
    "remoteKeyboard",
    "enabled",
    false,
  );
  const listen = vi.spyOn(window, "addEventListener");
  fixture();
  const keydown = listen.mock.calls.find(
    ([name]) => String(name) === "keydown",
  )![1] as (event: KeyboardEvent) => void;
  const editor = document.createElement("textarea");
  const event = (target: EventTarget) =>
    ({
      ...physical,
      composedPath: () => [target, window],
    }) as unknown as KeyboardEvent;
  keydown(event(editor));
  expect(
    appState.capabilities.localInput.keyboardObserved,
  ).toBe(false);
  window.dispatchEvent(
    new KeyboardEvent("keydown", {
      code: "KeyA",
      key: "a",
    }),
  );
  expect(
    appState.capabilities.localInput.keyboardObserved,
  ).toBe(false);
  keydown(event(document.body));
  expect(
    appState.capabilities.localInput.keyboardObserved,
  ).toBe(true);
  expect(appState.options.remoteKeyboard.enabled).toBe(
    false,
  );
});
