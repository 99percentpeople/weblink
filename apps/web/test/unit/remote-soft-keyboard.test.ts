import {
  afterEach,
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
afterEach(() => {
  cleanups.splice(0).forEach((close) => close());
  Reflect.deleteProperty(
    window.navigator,
    "virtualKeyboard",
  );
  Reflect.deleteProperty(document, "fullscreenElement");
  document.body.replaceChildren();
});
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
  it("focuses the fullscreen editor and requests the OS keyboard in the same gesture with manual policy", () => {
    const api = new KeyboardAPI();
    const { editor, screen, keyboard } = setup(api);
    api.show.mockImplementation(() => {
      expect(document.activeElement).toBe(editor);
      expect(
        editor.getAttribute("virtualkeyboardpolicy"),
      ).toBe("manual");
      expect(document.fullscreenElement).toBe(screen);
    });
    keyboard.show();
    expect(api.show).toHaveBeenCalledOnce();
    api.hide.mockImplementation(() => {
      expect(document.activeElement).toBe(editor);
      expect(
        editor.getAttribute("virtualkeyboardpolicy"),
      ).toBe("manual");
    });
    keyboard.hide();
    keyboard.hide();
    expect(api.hide).toHaveBeenCalledOnce();
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
      editor.hasAttribute("virtualkeyboardpolicy"),
    ).toBe(false);
    keyboard.hide();
    expect(document.activeElement).not.toBe(editor);
  });
  it("reports OS dismissal without hiding or blurring and can reopen the focused editor", () => {
    const api = new KeyboardAPI();
    const { editor, keyboard, visibility } = setup(api);
    keyboard.show();
    visibility.mockClear();
    api.resize(0);
    expect(visibility).not.toHaveBeenCalled();
    api.resize(320);
    api.resize(0);
    expect(visibility.mock.calls).toEqual([
      [true],
      [false],
    ]);
    expect(api.hide).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(editor);
    keyboard.show();
    expect(api.show).toHaveBeenCalledTimes(2);
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
    expect(visibility.mock.calls).toEqual([
      [true],
      [false],
      [true],
    ]);
  });
  it("repeated show requests never schedule a hide before showing", () => {
    const api = new KeyboardAPI();
    const { editor, keyboard } = setup(api);
    keyboard.show();
    keyboard.show();
    expect(api.show).toHaveBeenCalledTimes(2);
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
  it("restores automatic keyboard policy when the browser rejects explicit show", () => {
    const api = new KeyboardAPI();
    const { editor, keyboard } = setup(api);
    api.show.mockImplementation(() => {
      throw new Error("unavailable");
    });
    expect(() => keyboard.show()).not.toThrow();
    expect(
      editor.hasAttribute("virtualkeyboardpolicy"),
    ).toBe(false);
    expect(document.activeElement).toBe(editor);
    keyboard.hide();
    expect(document.activeElement).not.toBe(editor);
  });
  it("ignores an editor removed with its screen", () => {
    const api = new KeyboardAPI();
    const { editor, keyboard } = setup(api);
    editor.remove();
    keyboard.show();
    expect(api.show).not.toHaveBeenCalled();
  });
});
