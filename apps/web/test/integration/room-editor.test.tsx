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
  within,
  waitFor,
} from "@solidjs/testing-library";
import {
  createRoomDialog,
  joinUrl,
} from "@/components/dialogs/join-dialog";
import { createRoomActions } from "@/libs/state/create-room-actions";
import { ModalProvider } from "@/components/dialogs/base";
import { toast } from "solid-sonner";
import { reconcile } from "solid-js/store";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import { createMessageStores } from "@/libs/application/messaging/message-store";
import { createMessageRepository } from "../support/message-repository";
import {
  roomConversationId,
  type RoomConversation,
} from "@/libs/domain/conversation";

vi.mock("@/libs/application/room-identity", () => ({
  getRoomNamespace: () => "test-server",
}));
const historyStore = createMessageStores(
  createMessageRepository(),
);
const setRooms = (rooms: RoomConversation[]) =>
  setAppState("message", "conversations", reconcile(rooms));

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: { error: vi.fn() },
}));
vi.mock("@/components/icons", () => ({
  IconCasino: () => null,
  IconContentCopy: () => null,
  IconInfo: () => null,
  IconUploadFile: () => null,
  IconVisibility: () => null,
  IconVisibilityOff: () => null,
}));

let animationStyle: HTMLStyleElement;
beforeEach(async () => {
  await historyStore.initialize();
  setRooms([]);
  setAppState(
    "session",
    "clientServiceStatus",
    "disconnected",
  );
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
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("room sharing URL", () => {
  it.each([
    "https://dev.webl.ink",
    "https://webl.ink",
    "https://self-hosted.example/weblink/",
  ])(
    "shares %s instead of the desktop window origin",
    (base) => {
      vi.stubEnv("VITE_SHARE_URL", base);
      vi.stubGlobal("location", {
        origin: "https://tauri.localhost",
      });
      setAppState("profile", {
        roomId: "room & 中文",
        password: "password+#?",
      });

      const url = new URL(joinUrl());
      expect(url.origin).toBe(new URL(base).origin);
      expect(url.pathname).toBe(new URL(base).pathname);
      expect(url.searchParams.get("id")).toBe(
        "room & 中文",
      );
      expect(url.searchParams.get("pwd")).toBe(
        "password+#?",
      );

      setAppState("profile", {
        roomId: "next-room",
        password: null,
      });
      const updated = new URL(joinUrl());
      expect(updated.origin).toBe(new URL(base).origin);
      expect(updated.searchParams.get("id")).toBe(
        "next-room",
      );
      expect(updated.searchParams.has("pwd")).toBe(false);
    },
  );

  it("keeps the browser origin when no sharing URL is configured", () => {
    vi.stubEnv("VITE_SHARE_URL", "");
    setAppState("profile", "roomId", "browser-room");
    const url = new URL(joinUrl());
    expect(url.origin).toBe(location.origin);
    expect(url.searchParams.get("id")).toBe("browser-room");
  });
});

function setup(options?: {
  retry?: boolean;
  join?: () => Promise<void>;
}) {
  const completed = vi.fn();
  function Harness() {
    const dialog = createRoomDialog();
    const actions = options?.join
      ? createRoomActions({
          state: { joinRoom: options.join },
          dialog,
          history: historyStore,
          namespace: "test-server",
        })
      : undefined;
    return (
      <>
        <button
          onClick={() =>
            void (
              actions
                ? actions.edit()
                : dialog.open(options)
            ).then(completed)
          }
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
  const savedRoom = (
    roomId: string,
    lastJoinedAt: number,
  ): RoomConversation => ({
    id: roomConversationId("test-server", roomId),
    kind: "room",
    roomId,
    namespace: "test-server",
    title: roomId,
    labelIds: [],
    createdAt: 1,
    lastJoinedAt,
    joinPassword: "saved-password",
  });

  it.each([true, false])(
    "returns failed additions to their form without adding history and saves only after retry succeeds (first=%s)",
    async (first) => {
      vi.mocked(toast.error).mockClear();
      if (!first) setRooms([savedRoom("previous", 10)]);
      setAppState("profile", "initalJoin", first);
      let reject!: (error: Error) => void;
      const join = vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<void>((_, no) => {
              reject = no;
            }),
        )
        .mockImplementationOnce(async () => {
          await historyStore.recordRoomJoin(
            appState.profile.roomId,
            "test-server",
            appState.profile.password,
            100,
          );
          setAppState("profile", "initalJoin", false);
        });
      setup({ join });
      await screen.findByRole("dialog");
      fireEvent.click(
        screen.getByRole("button", {
          name: first
            ? "common.action.continue"
            : "common.join_form.history.add",
        }),
      );
      fireEvent.input(
        screen.getByLabelText(
          "common.join_form.room_id.title",
        ),
        {
          target: { value: "new-room" },
        },
      );
      fireEvent.input(
        screen.getByLabelText(
          "common.join_form.password.title",
        ),
        {
          target: { value: "wrong-password" },
        },
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "client.menu.connect",
        }),
      );
      await waitFor(() =>
        expect(join).toHaveBeenCalledOnce(),
      );
      const initialHistory = first ? [] : ["previous"];
      expect(
        appState.message.conversations.map(
          (room) => room.title,
        ),
      ).toEqual(initialHistory);
      reject(
        new Error(
          first
            ? "incorrect password"
            : "connection timeout",
        ),
      );
      await waitFor(() =>
        expect(toast.error).toHaveBeenCalledOnce(),
      );
      expect(
        await screen.findByLabelText(
          "common.join_form.room_id.title",
        ),
      ).toHaveValue("new-room");
      expect(screen.queryByRole("list")).toBeNull();
      expect(
        screen.getByLabelText(
          "common.join_form.password.title",
        ),
      ).toHaveValue("wrong-password");
      expect(
        appState.message.conversations.map(
          (room) => room.title,
        ),
      ).toEqual(initialHistory);
      fireEvent.input(
        screen.getByLabelText(
          "common.join_form.password.title",
        ),
        {
          target: { value: "correct-password" },
        },
      );
      fireEvent.click(
        screen.getByRole("button", {
          name: "client.menu.connect",
        }),
      );
      await waitFor(() =>
        expect(join).toHaveBeenCalledTimes(2),
      );
      await waitFor(() =>
        expect(screen.queryByRole("dialog")).toBeNull(),
      );
      expect(
        appState.message.conversations.filter(
          (room) => room.title === "new-room",
        ),
      ).toMatchObject([
        {
          lastJoinedAt: 100,
          joinPassword: "correct-password",
        },
      ]);
    },
  );

  it("uses existing rooms in most recently joined order and restores the selected credentials", async () => {
    setRooms([
      savedRoom("older", 10),
      savedRoom("latest", 30),
      {
        ...savedRoom("hidden", 40),
        joinHistoryHidden: true,
      },
      {
        ...savedRoom("elsewhere", 50),
        namespace: "another-server",
      },
    ]);
    const { completed } = setup();
    const list = screen.getByRole("list", {
      name: "common.join_form.history.title",
    });
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((item) =>
          within(item)
            .getAllByRole("button")[0]
            .getAttribute("aria-label"),
        ),
    ).toEqual(["latest", "older"]);
    expect(
      screen.queryByRole("button", {
        name: "hidden",
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "older",
      }),
    );
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
          roomId: "older",
          password: "saved-password",
        }),
      }),
    );
    expect(appState.profile.clientId).toBe("uid_saved");
  });

  it("switches between history and a blank add-room form and falls back to the form after removing the final entry", async () => {
    setRooms([savedRoom("saved", 10)]);
    const { completed } = setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.join_form.history.add",
      }),
    );
    expect(
      screen.getByLabelText(
        "common.join_form.room_id.title",
      ),
    ).toHaveValue("");
    expect(screen.queryByRole("list")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.join_form.history.back",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.join_form.history.remove",
      }),
    );
    expect(screen.queryByRole("list")).toBeNull();
    expect(
      screen.getByLabelText(
        "common.join_form.room_id.title",
      ),
    ).toHaveValue("");
    expect(appState.message.conversations).toHaveLength(1);
    expect(appState.message.conversations[0]).toMatchObject(
      { joinHistoryHidden: true },
    );
    expect(completed).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: "common.action.close",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Edit" }),
    );
    expect(screen.queryByRole("list")).toBeNull();
  });

  it("allows legacy rooms to supply credentials without reusing another room's password", () => {
    const room = savedRoom("legacy", 10);
    delete room.joinPassword;
    setRooms([room]);
    setAppState(
      "profile",
      "password",
      "unrelated-password",
    );
    const { completed } = setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: "client.menu.connect",
      }),
    );
    expect(completed).not.toHaveBeenCalled();
    expect(
      screen.getByLabelText(
        "common.join_form.room_id.title",
      ),
    ).toHaveValue("legacy");
    expect(
      screen.getByLabelText(
        "common.join_form.password.title",
      ),
    ).toHaveValue("");
  });

  it("accepts a dropped avatar image through the existing crop and save flow", async () => {
    const drawImage = vi.fn();
    vi.spyOn(
      HTMLCanvasElement.prototype,
      "getContext",
    ).mockReturnValue({
      drawImage,
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(
      HTMLCanvasElement.prototype,
      "toDataURL",
    ).mockReturnValue("data:image/png;base64,avatar");
    let image!: HTMLImageElement;
    vi.stubGlobal(
      "Image",
      class {
        constructor() {
          image = document.createElement("img");
          image.width = 256;
          image.height = 128;
          return image;
        }
      },
    );
    setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: /common.join_form.steps.profile/,
      }),
    );
    const avatar = screen.getAllByRole("button", {
      name: "common.join_form.upload_avatar",
    })[0];
    const file = new File(["image"], "avatar.png", {
      type: "image/png",
    });
    const read = vi.spyOn(
      FileReader.prototype,
      "readAsDataURL",
    );
    expect(
      fireEvent.drop(avatar, {
        dataTransfer: {
          types: ["Files"],
          files: [new File(["text"], "note.txt"), file],
        },
      }),
    ).toBe(false);
    expect(read).toHaveBeenCalledWith(file);
    expect(avatar).toBeDisabled();
    fireEvent.drop(avatar, {
      dataTransfer: { types: ["Files"], files: [file] },
    });
    expect(read).toHaveBeenCalledOnce();
    await waitFor(() =>
      expect(image?.onload).toBeTypeOf("function"),
    );
    fireEvent.load(image);
    await waitFor(() =>
      expect(appState.profile.avatar).toBe(
        "data:image/png;base64,avatar",
      ),
    );
    expect(drawImage).toHaveBeenCalledOnce();
    expect(avatar).not.toBeDisabled();
  });

  it("rejects a dropped non-image without replacing the avatar", async () => {
    vi.mocked(toast.error).mockClear();
    setup();
    fireEvent.click(
      screen.getByRole("button", {
        name: /common.join_form.steps.profile/,
      }),
    );
    const avatar = screen.getAllByRole("button", {
      name: "common.join_form.upload_avatar",
    })[0];
    fireEvent.drop(avatar, {
      dataTransfer: {
        types: ["Files"],
        files: [
          new File(["text"], "note.txt", {
            type: "text/plain",
          }),
        ],
      },
    });
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledOnce(),
    );
    expect(appState.profile.avatar).toBeNull();
    expect(avatar).not.toBeDisabled();
  });

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
          initalJoin: true,
        }),
      }),
    );
    expect(appState.profile.clientId).toBe("uid_saved");
    expect(appState.profile.name).toBe("Alice");
    expect(appState.profile.initalJoin).toBe(true);
  });

  it("reopens a failed new room on its form with the entered values, even when other history exists", () => {
    setRooms([savedRoom("previous", 10)]);
    setAppState("profile", {
      initalJoin: true,
      roomId: "new-room",
      password: "entered-password",
    });
    setup({ retry: true });
    expect(screen.queryByRole("list")).toBeNull();
    expect(
      screen.getByLabelText(
        "common.join_form.room_id.title",
      ),
    ).toHaveValue("new-room");
    expect(
      screen.getByLabelText(
        "common.join_form.password.title",
      ),
    ).toHaveValue("entered-password");
    expect(
      screen.getByRole("button", {
        name: "client.menu.connect",
      }),
    ).toBeVisible();
    expect(appState.profile.initalJoin).toBe(true);
    expect(appState.message.conversations).toHaveLength(1);
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
