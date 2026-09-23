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
  function Harness() {
    const dialog = createRoomDialog();
    return (
      <>
        <button onClick={() => void dialog.open()}>
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
}

describe("room profile drafts", () => {
  it("discards canceled edits and starts the next edit from saved values", async () => {
    setup();
    const input = await screen.findByLabelText(
      "common.join_form.room_id.title",
    );
    fireEvent.input(input, {
      target: { value: "unsaved" },
    });
    expect(appState.profile.roomId).toBe("old-room");
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.cancel",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Edit" }),
    );
    expect(
      await screen.findByLabelText(
        "common.join_form.room_id.title",
      ),
    ).toHaveValue("old-room");
  });

  it("saves confirmed information without replacing the user identity", async () => {
    setup();
    fireEvent.input(
      await screen.findByLabelText(
        "common.join_form.room_id.title",
      ),
      { target: { value: "new-room" } },
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.confirm",
      }),
    );
    await waitFor(() =>
      expect(appState.profile.roomId).toBe("new-room"),
    );
    expect(appState.profile.clientId).toBe("uid_saved");
    expect(appState.profile.name).toBe("Alice");
    expect(appState.profile.initalJoin).toBe(false);
  });
});
