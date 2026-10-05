// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  MeetingTileAction,
  MeetingTileActions,
} from "@/routes/home/components/meeting-tile-actions";
import { RemoteKeyboardInput } from "@/routes/home/components/remote-keyboard-input";
import type { RemotePointer } from "@/libs/domain/remote-control/pointer";
import { platform } from "@/libs/platform/runtime";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: { error: vi.fn() },
}));
vi.mock("@/libs/state/app-state", () => ({
  appState: {
    capabilities: { clipboard: { ready: false } },
    options: {
      remoteKeyboard: { enabled: true },
      remoteTouch: {},
    },
  },
}));

class KeyboardAPI extends EventTarget {
  boundingRect = { height: 0 };
  show = vi.fn();
  hide = vi.fn();
}
let animationStyle: HTMLStyleElement;
const runtimeKind = platform.kind;
beforeEach(() => {
  animationStyle = document.createElement("style");
  animationStyle.textContent =
    "* { animation-name: none !important; }";
  document.head.append(animationStyle);
  vi.stubGlobal("innerWidth", 390);
  window.dispatchEvent(new Event("resize"));
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(async () => {
  cleanup();
  // Kobalte releases focus scopes on the following task.
  await new Promise((resolve) => setTimeout(resolve, 0));
  animationStyle.remove();
  Reflect.deleteProperty(navigator, "virtualKeyboard");
  Reflect.deleteProperty(document, "fullscreenElement");
  Object.defineProperty(platform, "kind", {
    value: runtimeKind,
  });
  vi.unstubAllGlobals();
});

function setup(fullscreen = false, virtualKeyboard = true) {
  const api = new KeyboardAPI();
  if (virtualKeyboard)
    Object.defineProperty(navigator, "virtualKeyboard", {
      configurable: true,
      value: api,
    });
  const control = {
    supportsText: () => true,
    input: vi.fn(() => true),
    cancel: vi.fn(),
    resetInput: vi.fn(),
    setCursorVisible: vi.fn(),
  } as unknown as RemotePointer;
  const action = vi.fn();
  const [host, setHost] = createSignal<HTMLDivElement>();
  render(() => (
    <div ref={setHost}>
      <MeetingTileActions
        compact
        label="Actions"
        portalMount={fullscreen ? host() : undefined}
      >
        <RemoteKeyboardInput
          control={control}
          state="active"
          enabled
        />
        <MeetingTileAction
          label="Other action"
          onAction={action}
        />
      </MeetingTileActions>
    </div>
  ));
  if (fullscreen)
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      value: host(),
    });
  const editor = screen.getByRole(
    "textbox",
  ) as HTMLTextAreaElement;
  const trigger = screen.getByRole("button", {
    name: "Actions",
  });
  const openMenu = async () => {
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const menu = await screen.findByRole("menu");
    await waitFor(() =>
      expect(menu.contains(document.activeElement)).toBe(
        true,
      ),
    );
    return menu;
  };
  const expectEditorReady = () => {
    expect(document.activeElement).toBe(editor);
    expect(
      editor.getAttribute("virtualkeyboardpolicy"),
    ).toBe("auto");
    // The optional API observes geometry; focus requests IME on both HTTP and HTTPS.
    expect(api.show).not.toHaveBeenCalled();
    expect(api.hide).not.toHaveBeenCalled();
  };
  const enterText = async () => {
    fireEvent.compositionStart(editor);
    editor.value = "zhongwen";
    fireEvent.input(editor, {
      inputType: "insertCompositionText",
      data: "zhongwen",
      isComposing: true,
    });
    expect(control.input).not.toHaveBeenCalled();
    editor.value = "中文";
    fireEvent.compositionEnd(editor, { data: "中文" });
    fireEvent.input(editor, {
      inputType: "insertFromComposition",
      data: "中文",
    });
    await waitFor(() =>
      expect(control.input).toHaveBeenCalledOnce(),
    );
    expect(control.input).toHaveBeenCalledWith({
      type: "text",
      text: "中文",
    });
  };
  return {
    api,
    action,
    editor,
    trigger,
    openMenu,
    host,
    expectEditorReady,
    enterText,
  };
}

describe("meeting action menu keyboard focus", () => {
  it.each([
    { runtime: "browser", width: 1440 },
    { runtime: "desktop", width: 1440 },
    { runtime: "desktop", width: 480 },
  ] as const)(
    "omits the keyboard menu action on $runtime at $width",
    async ({ runtime, width }) => {
      Object.defineProperty(platform, "kind", {
        value: runtime,
      });
      vi.stubGlobal("innerWidth", width);
      window.dispatchEvent(new Event("resize"));
      const f = setup();
      await f.openMenu();
      expect(
        screen.queryByRole("menuitem", {
          name: "remote_control.keyboard_show",
        }),
      ).toBeNull();
      expect(
        screen.getByRole("menuitem", {
          name: "Other action",
        }),
      ).toBeDefined();
    },
  );

  it("removes the keyboard menu action after leaving mobile mode without replacing the editor", async () => {
    const f = setup();
    await f.openMenu();
    expect(
      screen.getByRole("menuitem", {
        name: "remote_control.keyboard_show",
      }),
    ).toBeDefined();
    vi.stubGlobal("innerWidth", 1440);
    window.dispatchEvent(new Event("resize"));
    await waitFor(() =>
      expect(
        screen.queryByRole("menuitem", {
          name: "remote_control.keyboard_show",
        }),
      ).toBeNull(),
    );
    expect(screen.getByRole("textbox")).toBe(f.editor);
  });

  it.each([
    { fullscreen: false, virtualKeyboard: false },
    { fullscreen: false, virtualKeyboard: true },
    { fullscreen: true, virtualKeyboard: false },
    { fullscreen: true, virtualKeyboard: true },
  ])(
    "opens the keyboard in the completed touch click and retains focus (fullscreen=$fullscreen, virtualKeyboard=$virtualKeyboard)",
    async ({ fullscreen, virtualKeyboard }) => {
      const f = setup(fullscreen, virtualKeyboard);
      const menu = await f.openMenu();
      if (fullscreen)
        expect(f.host()!.contains(menu)).toBe(true);
      const item = screen.getByRole("menuitem", {
        name: "remote_control.keyboard_show",
      });
      const touch = (type: string) => {
        const event = new MouseEvent(type, {
          bubbles: true,
          button: 0,
        });
        Object.defineProperty(event, "pointerType", {
          value: "touch",
        });
        fireEvent(item, event);
      };
      touch("pointerdown");
      touch("pointerup");
      expect(document.activeElement).not.toBe(f.editor);
      // Mobile browsers synthesize mouse focus before the completed click.
      fireEvent.mouseDown(item);
      item.focus();
      fireEvent.mouseUp(item);
      expect(document.activeElement).not.toBe(f.editor);
      fireEvent.click(item);
      f.expectEditorReady();
      await new Promise((resolve) =>
        setTimeout(resolve, 0),
      );
      f.expectEditorReady();
      expect(screen.queryByRole("menu")).toBeNull();
      await f.enterText();
      if (fullscreen)
        expect(document.fullscreenElement).toBe(f.host());
    },
  );

  it.each([false, true])(
    "retains editor focus after keyboard selection and deferred menu cleanup (virtualKeyboard=%s)",
    async (virtualKeyboard) => {
      const f = setup(false, virtualKeyboard);
      await f.openMenu();
      fireEvent.keyDown(
        screen.getByRole("menuitem", {
          name: "remote_control.keyboard_show",
        }),
        { key: "Enter" },
      );
      f.expectEditorReady();
      await new Promise((resolve) =>
        setTimeout(resolve, 0),
      );
      f.expectEditorReady();
      expect(screen.queryByRole("menu")).toBeNull();
      await f.enterText();
    },
  );

  it("returns focus to the trigger after an ordinary action", async () => {
    const f = setup();
    await f.openMenu();
    fireEvent.keyDown(
      screen.getByRole("menuitem", {
        name: "Other action",
      }),
      { key: "Enter" },
    );
    expect(f.action).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(document.activeElement).toBe(f.trigger),
    );
    expect(f.api.show).not.toHaveBeenCalled();
  });
});
