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

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: { error: vi.fn() },
}));
vi.mock("@/libs/state/app-state", () => ({
  appState: {
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
beforeEach(() => {
  animationStyle = document.createElement("style");
  animationStyle.textContent =
    "* { animation-name: none !important; }";
  document.head.append(animationStyle);
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
  vi.unstubAllGlobals();
});

function setup(fullscreen = false) {
  const api = new KeyboardAPI();
  Object.defineProperty(navigator, "virtualKeyboard", {
    configurable: true,
    value: api,
  });
  const control = {
    supportsText: () => true,
    input: vi.fn(() => true),
    cancel: vi.fn(),
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
  return { api, action, editor, trigger, openMenu, host };
}

describe("meeting action menu keyboard focus", () => {
  it.each([false, true])(
    "opens the keyboard in the completed touch click and retains focus (fullscreen=%s)",
    async (fullscreen) => {
      const f = setup(fullscreen);
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
      expect(f.api.show).not.toHaveBeenCalled();
      // Mobile browsers synthesize mouse focus before the completed click.
      fireEvent.mouseDown(item);
      item.focus();
      fireEvent.mouseUp(item);
      fireEvent.click(item);
      expect(f.api.show).toHaveBeenCalledOnce();
      expect(document.activeElement).toBe(f.editor);
      await new Promise((resolve) =>
        setTimeout(resolve, 0),
      );
      expect(document.activeElement).toBe(f.editor);
      expect(screen.queryByRole("menu")).toBeNull();
      expect(f.api.hide).not.toHaveBeenCalled();
      if (fullscreen)
        expect(document.fullscreenElement).toBe(f.host());
    },
  );

  it("retains editor focus after keyboard selection and deferred menu cleanup", async () => {
    const f = setup();
    await f.openMenu();
    fireEvent.keyDown(
      screen.getByRole("menuitem", {
        name: "remote_control.keyboard_show",
      }),
      { key: "Enter" },
    );
    expect(f.api.show).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(f.editor);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(document.activeElement).toBe(f.editor);
    expect(screen.queryByRole("menu")).toBeNull();
  });

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
