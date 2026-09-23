// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
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
import { createRoomDialog } from "@/components/dialogs/join-dialog";
import { ModalProvider } from "@/components/dialogs/base";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/components/icons", () => ({
  IconCasino: () => null,
  IconContentCopy: () => null,
  IconInfo: () => null,
  IconUploadFile: () => null,
  IconVisibility: () => null,
  IconVisibilityOff: () => null,
}));

let animationStyle: HTMLStyleElement;
beforeEach(() => {
  animationStyle = document.createElement("style");
  animationStyle.textContent =
    "* { animation-name: none !important; }";
  document.head.append(animationStyle);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  setAppState("profile", {
    name: "Alice",
    roomId: "old-room",
    clientId: "uid_saved",
    password: null,
    avatar: null,
    autoJoin: false,
    initalJoin: false,
  });
});
afterEach(() => {
  cleanup();
  animationStyle.remove();
  vi.restoreAllMocks();
});

function setup() {
  const completed = vi.fn();
  function Harness() {
    const dialog = createRoomDialog();
    return (
      <>
        <button
          onClick={() => void dialog.open().then(completed)}
        >
          Edit
        </button>
        <ModalProvider />
      </>
    );
  }
  render(() => <Harness />);
  fireEvent.click(
    screen.getByRole("button", { name: "Edit" }),
  );
  return { completed };
}

describe("room settings autosave", () => {
  it("saves edits immediately and preserves them when closed without connecting", async () => {
    const { completed } = setup();
    const input = await screen.findByLabelText(
      "common.join_form.room_id.title",
    );
    fireEvent.input(input, {
      target: { value: "saved-room" },
    });
    expect(appState.profile.roomId).toBe("saved-room");
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.close",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
    expect(completed).toHaveBeenCalledWith({
      cancel: true,
      result: undefined,
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Edit" }),
    );
    expect(
      await screen.findByLabelText(
        "common.join_form.room_id.title",
      ),
    ).toHaveValue("saved-room");
  });

  it("submits a connection request without replacing the user identity", async () => {
    setAppState("profile", "initalJoin", true);
    const { completed } = setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.continue",
      }),
    );
    fireEvent.input(
      await screen.findByLabelText(
        "common.join_form.room_id.title",
      ),
      { target: { value: "new-room" } },
    );
    expect(appState.profile.roomId).toBe("new-room");
    expect(appState.profile.initalJoin).toBe(true);
    expect(completed).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "client.menu.connect",
      }),
    );
    await waitFor(() =>
      expect(completed).toHaveBeenCalledWith({
        cancel: false,
        result: expect.objectContaining({
          roomId: "new-room",
          initalJoin: false,
        }),
      }),
    );
    expect(appState.profile.clientId).toBe("uid_saved");
    expect(appState.profile.name).toBe("Alice");
    expect(appState.profile.initalJoin).toBe(false);
  });

  it("saves profile, password and automatic-connection settings without submitting", async () => {
    const { completed } = setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: /common.join_form.steps.profile/,
      }),
    );
    fireEvent.input(
      screen.getByLabelText("common.join_form.name"),
      { target: { value: "Updated Alice" } },
    );
    fireEvent.input(
      screen.getByLabelText("common.join_form.avatar"),
      {
        target: { value: "https://example.com/avatar.png" },
      },
    );
    expect(appState.profile.name).toBe("Updated Alice");
    expect(appState.profile.avatar).toBe(
      "https://example.com/avatar.png",
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: /common.join_form.steps.room/,
      }),
    );
    fireEvent.input(
      screen.getByLabelText(
        "common.join_form.password.title",
      ),
      { target: { value: "secret" } },
    );
    fireEvent.click(
      screen.getByRole("switch", {
        name: "common.join_form.auto_join",
      }),
    );
    expect(appState.profile.password).toBe("secret");
    expect(appState.profile.autoJoin).toBe(true);
    fireEvent.input(
      screen.getByLabelText(
        "common.join_form.password.title",
      ),
      { target: { value: "" } },
    );
    expect(appState.profile.password).toBeNull();
    expect(appState.profile.clientId).toBe("uid_saved");
    expect(completed).not.toHaveBeenCalled();
  });

  it("saves incomplete inputs but requires a name and room before connecting", async () => {
    const { completed } = setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: /common.join_form.steps.profile/,
      }),
    );
    fireEvent.input(
      screen.getByLabelText("common.join_form.name"),
      { target: { value: "   " } },
    );
    expect(appState.profile.name).toBe("   ");
    fireEvent.click(
      screen.getByRole("button", {
        name: /common.join_form.steps.room/,
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "client.menu.connect",
      }),
    );
    expect(completed).not.toHaveBeenCalled();
    expect(
      screen.getByRole("button", {
        name: /common.join_form.steps.profile/,
      }),
    ).toHaveAttribute("aria-current", "step");
    fireEvent.input(
      screen.getByLabelText("common.join_form.name"),
      { target: { value: "Alice" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.continue",
      }),
    );
    fireEvent.input(
      screen.getByLabelText(
        "common.join_form.room_id.title",
      ),
      { target: { value: "   " } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "client.menu.connect",
      }),
    );
    expect(appState.profile.roomId).toBe("   ");
    expect(completed).not.toHaveBeenCalled();
    fireEvent.input(
      screen.getByLabelText(
        "common.join_form.room_id.title",
      ),
      { target: { value: "ready" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "client.menu.connect",
      }),
    );
    await waitFor(() =>
      expect(completed).toHaveBeenCalledOnce(),
    );
  });
});
