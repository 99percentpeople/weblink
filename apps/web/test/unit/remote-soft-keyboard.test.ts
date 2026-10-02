import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRemoteSoftKeyboard } from "@/libs/hooks/remote-soft-keyboard";

class KeyboardAPI extends EventTarget {
  boundingRect = { height: 0 };
  show = vi.fn();
  hide = vi.fn();
  resize(height: number) {
    this.boundingRect = { height };
    this.dispatchEvent(new Event("geometrychange"));
  }
}
const cleanups: (() => void)[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  Reflect.deleteProperty(
    window.navigator,
    "virtualKeyboard",
  );
  Reflect.deleteProperty(document, "fullscreenElement");
  Reflect.deleteProperty(window, "visualViewport");
  document.body.replaceChildren();
  vi.useRealTimers();
});

class Viewport extends EventTarget {
  width = 400;
  height = 800;
  scale = 1;
  resize(height: number) {
    this.height = height;
    this.dispatchEvent(new Event("resize"));
  }
}
function setup(api?: KeyboardAPI) {
  if (api)
    Object.defineProperty(
      window.navigator,
      "virtualKeyboard",
      { configurable: true, value: api },
    );
  const screen = document.createElement("div");
  const editor = document.createElement("textarea");
  editor.inputMode = "text";
  screen.append(editor);
  document.body.append(screen);
  Object.defineProperty(document, "fullscreenElement", {
    configurable: true,
    value: screen,
  });
  const visibility = vi.fn();
  const keyboard = createRemoteSoftKeyboard(
    () => editor,
    visibility,
  );
  cleanups.push(keyboard.hide);
  return { editor, screen, keyboard, visibility };
}
describe("remote system keyboard", () => {
  it("uses native focus for a secure-context editor and observes geometry without driving the IME", () => {
    const api = new KeyboardAPI();
    const { editor, screen, keyboard } = setup(api);
    keyboard.show();
    expect(document.activeElement).toBe(editor);
    expect(
      editor.getAttribute("virtualkeyboardpolicy"),
    ).toBe("auto");
    keyboard.hide();
    keyboard.hide();
    expect(api.show).not.toHaveBeenCalled();
    expect(api.hide).not.toHaveBeenCalled();
    expect(document.activeElement).not.toBe(editor);
    expect(
      editor.hasAttribute("virtualkeyboardpolicy"),
    ).toBe(false);
    expect(document.fullscreenElement).toBe(screen);
  });
  it("keeps normal focus behavior when the API is unavailable", () => {
    const { editor, keyboard } = setup();
    keyboard.show();
    expect(document.activeElement).toBe(editor);
    expect(
      editor.getAttribute("virtualkeyboardpolicy"),
    ).toBe("auto");
    keyboard.hide();
    expect(document.activeElement).not.toBe(editor);
  });
  it("blocks automatic reopening on HTTP without relying on floating-keyboard geometry", () => {
    const { editor, keyboard } = setup();
    keyboard.show();
    // Android Back may leave focus and all viewport measurements unchanged.
    // A remote pointer gesture must not ask Android to show IME again.
    keyboard.suppressAutomaticShow();
    expect(document.activeElement).toBe(editor);
    expect(
      editor.getAttribute("virtualkeyboardpolicy"),
    ).toBe("manual");
    keyboard.show();
    expect(
      editor.getAttribute("virtualkeyboardpolicy"),
    ).toBe("auto");
    expect(document.activeElement).toBe(editor);
    keyboard.suppressAutomaticShow();
    keyboard.hide();
    expect(
      editor.hasAttribute("virtualkeyboardpolicy"),
    ).toBe(false);
    expect(document.activeElement).not.toBe(editor);
  });
  it("defers a transient dismissal and can reopen the focused editor", () => {
    const api = new KeyboardAPI();
    const { editor, keyboard, visibility } = setup(api);
    keyboard.show();
    visibility.mockClear();
    api.resize(0);
    expect(visibility).not.toHaveBeenCalled();
    api.resize(320);
    api.resize(0);
    expect(visibility.mock.calls).toEqual([[true]]);
    expect(api.hide).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
    keyboard.show();
    expect(api.show).not.toHaveBeenCalled();
    expect(api.hide).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
    visibility.mockClear();
    api.resize(0);
    expect(visibility).not.toHaveBeenCalled();
  });
  it("keeps focus through transient zero geometry during fullscreen keyboard animation", () => {
    const api = new KeyboardAPI();
    const { editor, screen, keyboard, visibility } =
      setup(api);
    keyboard.show();
    visibility.mockClear();
    for (const height of [300, 0, 160, 320]) {
      api.resize(height);
      expect(document.activeElement).toBe(editor);
      expect(document.fullscreenElement).toBe(screen);
      expect(api.hide).not.toHaveBeenCalled();
    }
    expect(visibility.mock.calls).toEqual([[true], [true]]);
  });
  it("repeated show requests never schedule a hide before showing", () => {
    const api = new KeyboardAPI();
    const { editor, keyboard } = setup(api);
    keyboard.show();
    keyboard.show();
    expect(api.show).not.toHaveBeenCalled();
    expect(api.hide).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
  });
  it("releases listeners and restores policy without hiding another editor's keyboard", () => {
    const api = new KeyboardAPI();
    const { editor, keyboard, visibility } = setup(api);
    editor.setAttribute("virtualkeyboardpolicy", "auto");
    keyboard.show();
    api.resize(300);
    const other = document.createElement("input");
    document.body.append(other);
    other.focus();
    visibility.mockClear();
    api.resize(0);
    expect(visibility).not.toHaveBeenCalled();
    keyboard.hide();
    expect(api.hide).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(other);
    expect(
      editor.getAttribute("virtualkeyboardpolicy"),
    ).toBe("auto");
    api.resize(300);
    api.resize(0);
    expect(visibility).not.toHaveBeenCalled();
  });
  it("ignores an editor removed with its screen", () => {
    const api = new KeyboardAPI();
    const { editor, keyboard } = setup(api);
    editor.remove();
    keyboard.show();
    expect(api.show).not.toHaveBeenCalled();
  });

  it("releases focus after sustained OS dismissal but not a transient zero geometry", () => {
    const api = new KeyboardAPI();
    const { editor, keyboard, visibility } = setup(api);
    keyboard.show();
    api.resize(300);
    api.resize(0);
    vi.advanceTimersByTime(100);
    expect(document.activeElement).toBe(editor);
    api.resize(300);
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(editor);
    expect(api.hide).not.toHaveBeenCalled();
    api.resize(0);
    vi.advanceTimersByTime(200);
    expect(document.activeElement).not.toBe(editor);
    expect(visibility).toHaveBeenLastCalledWith(false);
    expect(api.hide).not.toHaveBeenCalled();
  });

  it.each([true, false])(
    "detects fullscreen Back via viewport restoration when geometry events are absent (api=%s)",
    (withAPI) => {
      const viewport = new Viewport();
      Object.defineProperty(window, "visualViewport", {
        configurable: true,
        value: viewport,
      });
      const api = withAPI ? new KeyboardAPI() : undefined;
      const { editor, screen, keyboard, visibility } =
        setup(api);
      keyboard.show();
      viewport.resize(480);
      viewport.resize(800);
      vi.advanceTimersByTime(200);
      expect(visibility).toHaveBeenLastCalledWith(false);
      expect(document.activeElement).not.toBe(editor);
      expect(document.fullscreenElement).toBe(screen);
      visibility.mockClear();
      viewport.resize(480);
      expect(visibility).not.toHaveBeenCalled();
    },
  );

  it("keeps focus through opening animation gaps and viewport zoom or rotation", () => {
    const viewport = new Viewport();
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    const { editor, keyboard } = setup();
    keyboard.show();
    viewport.resize(480);
    viewport.resize(800);
    vi.advanceTimersByTime(100);
    viewport.resize(500);
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(editor);
    viewport.width = 800;
    viewport.resize(400);
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(editor);
  });

  it("trusts a restored viewport when fullscreen keyboard geometry remains stale", () => {
    const viewport = new Viewport();
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: viewport,
    });
    const api = new KeyboardAPI();
    const { editor, keyboard, visibility } = setup(api);
    keyboard.show();
    api.resize(300);
    viewport.resize(480);
    viewport.resize(800);
    expect(api.boundingRect.height).toBe(300);
    vi.advanceTimersByTime(200);
    expect(visibility).toHaveBeenLastCalledWith(false);
    expect(document.activeElement).not.toBe(editor);
    expect(api.hide).not.toHaveBeenCalled();
  });

  it("cancels pending dismissal when explicitly reopening the keyboard", () => {
    const api = new KeyboardAPI();
    const { editor, keyboard } = setup(api);
    keyboard.show();
    api.resize(300);
    api.resize(0);
    keyboard.show();
    vi.advanceTimersByTime(200);
    expect(document.activeElement).toBe(editor);
    expect(api.hide).not.toHaveBeenCalled();
    expect(api.show).not.toHaveBeenCalled();
  });
});
