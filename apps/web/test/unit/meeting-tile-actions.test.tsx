// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal, For } from "solid-js";
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

describe("desktop meeting toolbar interaction", () => {
  function setupToolbar() {
    const action = vi.fn();
    render(() => (
      <MeetingTileActions compact={false} label="Actions">
        <MeetingTileAction
          label="Other action"
          onAction={action}
        />
      </MeetingTileActions>
    ));
    const trigger = screen.getByRole("button", {
      name: "Actions",
    });
    const touch = () => {
      const event = new MouseEvent("pointerdown", {
        bubbles: true,
        button: 0,
      });
      Object.defineProperty(event, "pointerType", {
        value: "touch",
      });
      fireEvent(trigger, event);
      fireEvent.click(trigger, { detail: 1 });
    };
    return { trigger, touch, action };
  }

  it("opens on touch even when the primary device supports hover", () => {
    const f = setupToolbar();
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(f.trigger.getAttribute("aria-pressed")).toBe(
      "false",
    );
    f.touch();
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(f.trigger.getAttribute("aria-pressed")).toBe(
      "true",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Other action" }),
    );
    expect(f.action).toHaveBeenCalledOnce();
    f.touch();
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(f.trigger.getAttribute("aria-pressed")).toBe(
      "false",
    );
  });

  it("dismisses a clicked toolbar outside and on Escape, then can reopen", () => {
    const f = setupToolbar();
    f.touch();
    fireEvent.pointerDown(document.body);
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(f.trigger.getAttribute("aria-pressed")).toBe(
      "false",
    );
    f.touch();
    const action = screen.getByRole("button", {
      name: "Other action",
    });
    action.focus();
    fireEvent.keyDown(action, { key: "Escape" });
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(f.trigger.getAttribute("aria-pressed")).toBe(
      "false",
    );
    expect(document.activeElement).toBe(f.trigger);
    f.touch();
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("preserves mouse hover expansion without a click", async () => {
    const f = setupToolbar();
    const event = new MouseEvent("pointerenter");
    Object.defineProperty(event, "pointerType", {
      value: "mouse",
    });
    fireEvent(f.trigger.parentElement!, event);
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(f.trigger.getAttribute("aria-pressed")).toBe(
      "false",
    );
    fireEvent.pointerLeave(f.trigger.parentElement!);
    await waitFor(() =>
      expect(f.trigger.getAttribute("aria-expanded")).toBe(
        "false",
      ),
    );
  });
});

describe("floating meeting actions", () => {
  function setupFloating(
    compact: boolean,
    actionCount = 1,
  ) {
    const [floating, setFloating] = createSignal(true);
    vi.stubGlobal("innerWidth", 900);
    vi.stubGlobal("innerHeight", 700);
    const action = vi.fn();
    const surfaceInput = vi.fn();
    const view = render(() => (
      <div
        onPointerDown={surfaceInput}
        onClick={surfaceInput}
      >
        <MeetingTileActions
          compact={compact}
          floating={floating()}
          label="Actions"
        >
          <For
            each={Array.from(
              { length: actionCount },
              (_, i) => i,
            )}
          >
            {(index) => (
              <MeetingTileAction
                label={
                  actionCount === 1
                    ? "Other action"
                    : `Action ${index + 1}`
                }
                onAction={action}
              />
            )}
          </For>
        </MeetingTileActions>
      </div>
    ));
    const trigger = screen.getByRole("button", {
      name: "Actions",
    });
    const anchorRect = vi
      .spyOn(trigger, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(400, 300, 44, 44));
    const dock = trigger.parentElement!;
    const boundary = dock.parentElement!;
    // Supply a video surface in jsdom; assertions concern gestures and lifecycle,
    // not the CSS dimensions or animation geometry.
    Object.defineProperties(boundary, {
      clientWidth: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 400 },
    });
    Object.defineProperties(dock, {
      offsetWidth: { value: 44 },
      offsetHeight: { value: 44 },
    });
    vi.spyOn(
      boundary,
      "getBoundingClientRect",
    ).mockReturnValue(new DOMRect(0, 0, 600, 400));
    vi.spyOn(dock, "getBoundingClientRect").mockReturnValue(
      new DOMRect(556, 356, 44, 44),
    );
    const capture = vi.fn();
    const release = vi.fn();
    trigger.setPointerCapture = capture;
    trigger.hasPointerCapture = () => true;
    trigger.releasePointerCapture = release;
    window.dispatchEvent(new Event("resize"));
    const pointer = (
      type: string,
      x: number,
      y: number,
      options: {
        id?: number;
        pointerType?: string;
        primary?: boolean;
      } = {},
    ) => {
      const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        clientX: x,
        clientY: y,
      });
      Object.defineProperties(event, {
        pointerId: { value: options.id ?? 1 },
        pointerType: {
          value: options.pointerType ?? "mouse",
        },
        isPrimary: { value: options.primary ?? true },
      });
      fireEvent(trigger, event);
    };
    const tap = () => {
      pointer("pointerdown", 575, 375);
      pointer("pointerup", 576, 376);
      fireEvent.click(trigger, { detail: 1 });
    };
    return {
      ...view,
      trigger,
      dock,
      boundary,
      pointer,
      tap,
      capture,
      release,
      action,
      surfaceInput,
      setFloating,
      anchorRect,
    };
  }

  it("keeps secondary actions clickable without capturing a drag", () => {
    const f = setupFloating(true);
    f.setFloating(false);
    f.pointer("pointerdown", 575, 375);
    f.pointer("pointermove", 120, 180);
    f.pointer("pointerup", 120, 180);
    expect(f.capture).not.toHaveBeenCalled();
    expect(f.dock.hasAttribute("data-dragging")).toBe(
      false,
    );
    f.tap();
    fireEvent.click(
      screen.getByRole("menuitem", {
        name: "Other action",
      }),
    );
    expect(f.action).toHaveBeenCalledOnce();
  });

  it("keeps the same portaled menu and focus usable when switching the main source", () => {
    const f = setupFloating(true);
    f.tap();
    const menu = screen.getByRole("menu");
    expect(f.container.contains(menu)).toBe(false);
    f.setFloating(false);
    f.tap();
    expect(screen.getByRole("menu")).toBe(menu);
    expect(f.container.contains(menu)).toBe(false);
    expect(document.body.contains(menu)).toBe(true);
    const item = screen.getByRole("menuitem", {
      name: "Other action",
    });
    fireEvent.pointerDown(item);
    item.focus();
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "true",
    );
    fireEvent.click(item);
    expect(f.action).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(f.trigger);
    f.setFloating(true);
    f.tap();
    expect(screen.getByRole("menu")).toBe(menu);
    expect(f.container.contains(menu)).toBe(false);
  });

  it("keeps a hovered thumbnail menu open when the pointer enters its portal", async () => {
    const f = setupFloating(false);
    f.setFloating(false);
    const enter = (target: HTMLElement) => {
      const event = new MouseEvent("pointerenter");
      Object.defineProperty(event, "pointerType", {
        value: "mouse",
      });
      fireEvent(target, event);
    };
    enter(f.dock);
    const menu = screen.getByRole("toolbar");
    fireEvent.pointerLeave(f.dock);
    enter(menu);
    await new Promise((resolve) =>
      setTimeout(resolve, 200),
    );
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "true",
    );
    fireEvent.pointerLeave(menu);
    await waitFor(() =>
      expect(f.trigger.getAttribute("aria-expanded")).toBe(
        "false",
      ),
    );
    f.tap();
    fireEvent.pointerDown(document.body);
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("removes the portal and stops following the anchor on unmount", () => {
    const cancelFrame = vi.spyOn(
      window,
      "cancelAnimationFrame",
    );
    const f = setupFloating(true);
    f.setFloating(false);
    f.tap();
    const menu = screen.getByRole("menu");
    f.unmount();
    expect(document.body.contains(menu)).toBe(false);
    expect(cancelFrame).toHaveBeenCalled();
  });

  it("ends an active drag when the tile stops being main and restores dragging when selected again", () => {
    const f = setupFloating(true);
    f.pointer("pointerdown", 575, 375);
    f.pointer("pointermove", 120, 180);
    f.setFloating(false);
    expect(f.release).toHaveBeenCalledWith(1);
    expect(f.dock.hasAttribute("data-dragging")).toBe(
      false,
    );
    f.pointer("pointerup", 120, 180);
    fireEvent.click(f.trigger, { detail: 1 });
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "false",
    );
    f.tap();
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "true",
    );
    f.setFloating(true);
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "false",
    );
    f.pointer("pointerdown", 575, 375);
    f.pointer("pointermove", 120, 180);
    expect(f.dock.hasAttribute("data-dragging")).toBe(true);
    f.pointer("pointerup", 120, 180);
    expect(f.dock.dataset.edge).toBe("left");
  });

  it.each([false, true])(
    "keeps a slightly moving tap usable (compact=%s)",
    async (compact) => {
      const f = setupFloating(compact);
      f.pointer("pointerdown", 575, 375);
      expect(f.trigger.getAttribute("aria-expanded")).toBe(
        "false",
      );
      f.pointer("pointerup", 576, 376);
      fireEvent.click(f.trigger, { detail: 1 });
      expect(f.trigger.getAttribute("aria-expanded")).toBe(
        "true",
      );
      if (compact) await screen.findByRole("menu");
      expect(f.surfaceInput).not.toHaveBeenCalled();
      expect(f.release).toHaveBeenCalledWith(1);
    },
  );

  it.each([
    { compact: false, pointerType: "mouse" },
    { compact: true, pointerType: "mouse" },
    { compact: true, pointerType: "touch" },
    { compact: false, pointerType: "pen" },
  ])(
    "docks a $pointerType drag without opening actions (compact=$compact)",
    async ({ compact, pointerType }) => {
      const f = setupFloating(compact);
      f.pointer("pointerdown", 575, 375, { pointerType });
      f.pointer("pointermove", 120, 180, { pointerType });
      expect(f.dock.hasAttribute("data-dragging")).toBe(
        true,
      );
      f.pointer("pointerup", 120, 180, { pointerType });
      fireEvent.click(f.trigger, { detail: 1 });
      expect(f.dock.hasAttribute("data-dragging")).toBe(
        false,
      );
      expect(f.dock.dataset.edge).toBe("left");
      expect(f.trigger.getAttribute("aria-expanded")).toBe(
        "false",
      );
      expect(f.action).not.toHaveBeenCalled();
      expect(f.surfaceInput).not.toHaveBeenCalled();
      expect(f.capture).toHaveBeenCalledWith(1);
      expect(f.release).toHaveBeenCalledWith(1);
      const enter = new MouseEvent("pointerenter");
      Object.defineProperty(enter, "pointerType", {
        value: "mouse",
      });
      fireEvent(f.dock, enter);
      expect(f.trigger.getAttribute("aria-expanded")).toBe(
        "false",
      );
      f.tap();
      expect(f.trigger.getAttribute("aria-expanded")).toBe(
        "true",
      );
      if (compact) await screen.findByRole("menu");
    },
  );

  it.each(["pointercancel", "lostpointercapture", "blur"])(
    "ends a drag after %s and retains keyboard access",
    (ending) => {
      const f = setupFloating(true);
      f.pointer("pointerdown", 575, 375);
      f.pointer("pointermove", 120, 180);
      if (ending === "blur")
        window.dispatchEvent(new Event("blur"));
      else f.pointer(ending, 120, 180);
      expect(f.dock.hasAttribute("data-dragging")).toBe(
        false,
      );
      fireEvent.click(f.trigger, { detail: 1 });
      expect(f.trigger.getAttribute("aria-expanded")).toBe(
        "false",
      );
      fireEvent.keyDown(f.trigger, { key: "ArrowDown" });
      expect(f.trigger.getAttribute("aria-expanded")).toBe(
        "true",
      );
    },
  );

  it("ignores a second contact during a drag", () => {
    const f = setupFloating(true);
    f.pointer("pointerdown", 575, 375, {
      pointerType: "touch",
    });
    f.pointer("pointermove", 120, 180, {
      pointerType: "touch",
    });
    f.pointer("pointerdown", 560, 300, {
      id: 2,
      primary: false,
    });
    f.pointer("pointerup", 560, 300, {
      id: 2,
      primary: false,
    });
    expect(f.dock.hasAttribute("data-dragging")).toBe(true);
    f.pointer("pointerup", 120, 180);
    expect(f.dock.dataset.edge).toBe("left");
    expect(f.capture).toHaveBeenCalledOnce();
  });

  it("retains the chosen edge across resizing and fullscreen changes", () => {
    const f = setupFloating(false);
    f.pointer("pointerdown", 575, 375);
    f.pointer("pointermove", 120, 180);
    f.pointer("pointerup", 120, 180);
    Object.defineProperty(f.boundary, "clientWidth", {
      value: 320,
    });
    window.dispatchEvent(new Event("resize"));
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(f.dock.dataset.edge).toBe("left");
    f.tap();
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "true",
    );
  });

  it("releases capture, observers and pending movement on unmount", () => {
    const disconnect = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect = disconnect;
      },
    );
    const cancelFrame = vi.spyOn(
      window,
      "cancelAnimationFrame",
    );
    const f = setupFloating(false);
    f.pointer("pointerdown", 575, 375);
    f.pointer("pointermove", 120, 180);
    f.unmount();
    expect(f.release).toHaveBeenCalledWith(1);
    expect(disconnect).toHaveBeenCalled();
    expect(cancelFrame).toHaveBeenCalled();
    const releases = f.release.mock.calls.length;
    f.pointer("pointerup", 120, 180);
    window.dispatchEvent(new Event("resize"));
    expect(f.release).toHaveBeenCalledTimes(releases);
  });

  it.each([
    { edge: "left", x: 100, y: 180 },
    { edge: "right", x: 520, y: 180 },
    { edge: "top", x: 300, y: 60 },
    { edge: "bottom", x: 300, y: 340 },
  ])(
    "chooses the nearest $edge edge and preserves it after resizing",
    ({ edge, x, y }) => {
      const f = setupFloating(false);
      f.pointer("pointerdown", 575, 375);
      f.pointer("pointermove", x, y);
      f.pointer("pointerup", x, y);
      expect(f.dock.dataset.edge).toBe(edge);
      window.dispatchEvent(new Event("resize"));
      expect(f.dock.dataset.edge).toBe(edge);
    },
  );

  it("keeps every action reachable by paging a fan in a small viewport", () => {
    const f = setupFloating(true, 12);
    vi.stubGlobal("innerWidth", 240);
    vi.stubGlobal("innerHeight", 200);
    f.anchorRect.mockReturnValue(
      new DOMRect(188, 148, 44, 44),
    );
    window.dispatchEvent(new Event("resize"));
    f.tap();
    const visited = new Set<string>();
    for (let page = 0; page < 12; page++) {
      for (const item of screen.getAllByRole("menuitem")) {
        const label = item.getAttribute("aria-label")!;
        if (label.startsWith("Action ")) visited.add(label);
      }
      fireEvent.click(
        screen.getByRole("menuitem", {
          name: "common.pagination.next",
        }),
      );
    }
    expect(visited.size).toBe(12);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Action 1" }),
    );
    expect(f.action).toHaveBeenCalledOnce();
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(document.activeElement).toBe(f.trigger);
  });

  it("uses window space for a circle and adapts to a constrained edge without closing", () => {
    const f = setupFloating(true, 8);
    Object.defineProperty(f.boundary, "clientHeight", {
      value: 140,
    });
    window.dispatchEvent(new Event("resize"));
    f.tap();
    const menu = screen.getByRole("menu");
    expect(menu.dataset.layout).toBe("circle");
    expect(f.container.contains(menu)).toBe(false);
    f.anchorRect.mockReturnValue(
      new DOMRect(848, 648, 44, 44),
    );
    window.dispatchEvent(new Event("resize"));
    expect(menu.dataset.layout).toBe("fan");
    expect(f.trigger.getAttribute("aria-expanded")).toBe(
      "true",
    );
    f.anchorRect.mockReturnValue(
      new DOMRect(400, 300, 44, 44),
    );
    window.dispatchEvent(new Event("resize"));
    expect(menu.dataset.layout).toBe("circle");
    expect(screen.getAllByRole("menuitem")).toHaveLength(8);
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Action 1" }),
    );
    expect(f.action).toHaveBeenCalledOnce();
  });

  it("navigates fan actions with arrow keys and returns focus on Escape", async () => {
    const f = setupFloating(true, 3);
    fireEvent.keyDown(f.trigger, { key: "ArrowDown" });
    const first = await screen.findByRole("menuitem", {
      name: "Action 1",
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(first),
    );
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Action 2" }),
    );
    fireEvent.keyDown(document.activeElement!, {
      key: "End",
    });
    expect(document.activeElement).toBe(
      screen.getByRole("menuitem", { name: "Action 3" }),
    );
    fireEvent.keyDown(document.activeElement!, {
      key: "Escape",
    });
    expect(document.activeElement).toBe(f.trigger);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
