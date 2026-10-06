import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot } from "solid-js";
import { reconcile } from "solid-js/store";
import type { RoomConversation } from "@/libs/domain/conversation";
import { createRoomActions } from "@/libs/state/create-room-actions";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

const fixture = vi.hoisted(() => ({
  open: vi.fn(),
  join: vi.fn(),
  error: vi.fn(),
  initialize: vi.fn(),
}));
vi.mock("solid-sonner", () => ({
  toast: { error: fixture.error },
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
let dispose: () => void;
const setup = () =>
  createRoot((cleanup) => {
    dispose = cleanup;
    return createRoomActions({
      state: { joinRoom: fixture.join },
      dialog: { open: fixture.open },
      history: {
        initialize: fixture.initialize,
        conversations: appState.message.conversations,
      },
      namespace: "server",
    });
  });

const savedRoom = (
  roomId: string,
  lastJoinedAt: number,
  joinPassword: string | null | undefined = "room-password",
): RoomConversation => ({
  id: `room:${roomId}`,
  kind: "room",
  roomId,
  namespace: "server",
  title: roomId,
  labelIds: [],
  createdAt: 1,
  lastJoinedAt,
  joinPassword,
});
const setRooms = (rooms: RoomConversation[]) =>
  setAppState("message", "conversations", reconcile(rooms));

beforeEach(() => {
  vi.resetAllMocks();
  setAppState("message", "conversations", reconcile([]));
  vi.spyOn(console, "error").mockImplementation(() => {});
  setAppState("profile", {
    name: "Alice",
    roomId: "room",
    password: "saved-password",
    initalJoin: false,
  });
  setAppState(
    "session",
    "clientServiceStatus",
    "disconnected",
  );
  fixture.open.mockResolvedValue({ cancel: false });
  fixture.join.mockResolvedValue(undefined);
  fixture.initialize.mockResolvedValue(undefined);
});
afterEach(() => {
  dispose?.();
  vi.restoreAllMocks();
});

describe("shared room actions", () => {
  it("only takes over on the explicit switch action and does not reopen room settings", async () => {
    const actions = setup();
    fixture.join.mockRejectedValueOnce(
      new Error("Room is already open in another tab"),
    );
    await actions.join();
    expect(fixture.join).toHaveBeenLastCalledWith(
      undefined,
    );
    expect(fixture.error).not.toHaveBeenCalled();
    await actions.takeover();
    expect(fixture.join).toHaveBeenLastCalledWith({
      takeover: true,
    });
    expect(fixture.open).not.toHaveBeenCalled();
  });
  it("keeps a closed editor disconnected and joins directly on the next manual join", async () => {
    const actions = setup();
    fixture.open.mockResolvedValueOnce({ cancel: true });
    await actions.edit();
    expect(fixture.open).toHaveBeenCalledOnce();
    expect(fixture.join).not.toHaveBeenCalled();
    await actions.join();
    expect(fixture.open).toHaveBeenCalledOnce();
    expect(fixture.join).toHaveBeenCalledOnce();
    expect(appState.profile.roomId).toBe("room");
    expect(appState.profile.password).toBe(
      "saved-password",
    );
  });

  it("automatically joins the configured room without opening the chooser", async () => {
    setRooms([savedRoom("previous", 1)]);
    const actions = setup();
    await actions.autoJoin();
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.join).toHaveBeenCalledOnce();
    expect(appState.profile.roomId).toBe("room");
  });

  it.each(["last-password", null])(
    "joins the latest retained room with its saved password (%s) instead of an unconnected draft",
    async (password) => {
      const actions = setup();
      setRooms([
        savedRoom("old-room", 5),
        savedRoom("last-room", 20, password),
        {
          ...savedRoom("removed", 40),
          joinHistoryHidden: true,
        },
        {
          ...savedRoom("other-server", 50),
          namespace: "other",
        },
      ]);
      fixture.open.mockImplementationOnce(async () => {
        setAppState("profile", {
          roomId: "unconnected-draft",
          password: "draft-password",
        });
        return { cancel: true };
      });
      await actions.edit();
      expect(fixture.join).not.toHaveBeenCalled();
      fixture.join.mockImplementationOnce(async () => {
        expect(appState.profile.roomId).toBe("last-room");
        expect(appState.profile.password).toBe(password);
      });
      await actions.join();
      expect(fixture.open).toHaveBeenCalledOnce();
      expect(fixture.join).toHaveBeenCalledOnce();
    },
  );

  it.each([true, false])(
    "waits for saved history and rechecks room state before joining (still disconnected=%s)",
    async (disconnected) => {
      let resolve!: () => void;
      fixture.initialize.mockImplementationOnce(
        () =>
          new Promise<void>((done) => {
            resolve = done;
          }),
      );
      const actions = setup();
      const pending = actions.join();
      expect(actions.busy()).toBe(true);
      expect(fixture.join).not.toHaveBeenCalled();
      setRooms([savedRoom("loaded-room", 10)]);
      if (!disconnected)
        setAppState(
          "session",
          "clientServiceStatus",
          "connecting",
        );
      resolve();
      await pending;
      expect(fixture.join).toHaveBeenCalledTimes(
        disconnected ? 1 : 0,
      );
      expect(fixture.open).not.toHaveBeenCalled();
      expect(appState.profile.roomId).toBe(
        disconnected ? "loaded-room" : "room",
      );
    },
  );

  it.each(["removed", "other-server", "legacy"])(
    "requires editing instead of reusing unrelated credentials for %s history",
    async (kind) => {
      const room = savedRoom("last-room", 10);
      if (kind === "removed") room.joinHistoryHidden = true;
      if (kind === "other-server") room.namespace = "other";
      if (kind === "legacy") delete room.joinPassword;
      setRooms([room]);
      const actions = setup();
      await actions.join();
      expect(fixture.open).not.toHaveBeenCalled();
      expect(fixture.join).not.toHaveBeenCalled();
      expect(fixture.error).toHaveBeenCalledWith(
        "common.join_form.configure_before_join",
      );
      expect(appState.profile.password).toBe(
        "saved-password",
      );
    },
  );

  it("uses the existing profile password for its matching legacy room", async () => {
    const room = savedRoom("room", 10);
    delete room.joinPassword;
    delete room.lastJoinedAt;
    setRooms([room]);
    const actions = setup();
    await actions.join();
    expect(fixture.join).toHaveBeenCalledOnce();
    expect(fixture.open).not.toHaveBeenCalled();
    expect(appState.profile.password).toBe(
      "saved-password",
    );
  });

  it("connects when the settings dialog's Connect action is selected", async () => {
    setRooms([savedRoom("previous", 20)]);
    const actions = setup();
    await actions.edit();
    expect(fixture.open).toHaveBeenCalledOnce();
    expect(fixture.join).toHaveBeenCalledOnce();
    expect(fixture.initialize).toHaveBeenCalledOnce();
    expect(appState.profile.roomId).toBe("room");
    expect(actions.busy()).toBe(false);
  });

  it.each([
    { initalJoin: true },
    { name: "  " },
    { roomId: "  " },
  ])(
    "requires an explicit edit for incomplete setup %s",
    async (profile) => {
      const actions = setup();
      setAppState("profile", profile);
      await actions.join();
      await actions.autoJoin();
      expect(fixture.open).not.toHaveBeenCalled();
      expect(fixture.join).not.toHaveBeenCalled();
      expect(fixture.error).toHaveBeenCalledWith(
        "common.join_form.configure_before_join",
      );
      expect(actions.busy()).toBe(false);
      fixture.open.mockResolvedValueOnce({ cancel: true });
      await actions.edit();
      expect(fixture.open).toHaveBeenCalledOnce();
      expect(fixture.join).not.toHaveBeenCalled();
    },
  );

  it("blocks concurrent actions and allows retry after a failed join", async () => {
    const actions = setup();
    let fail!: (error: Error) => void;
    fixture.join.mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        }),
    );
    const joining = actions.join();
    expect(actions.busy()).toBe(true);
    await actions.join();
    await actions.edit();
    expect(fixture.join).toHaveBeenCalledOnce();
    expect(fixture.open).not.toHaveBeenCalled();
    fail(new Error("offline"));
    await joining;
    expect(actions.busy()).toBe(false);
    expect(fixture.error).toHaveBeenCalledWith(
      "errors.connection_failed",
    );
    await actions.join();
    expect(fixture.join).toHaveBeenCalledTimes(2);
    expect(appState.profile.roomId).toBe("room");
  });

  it.each(["incorrect password", "connection timeout"])(
    "returns a failed new room to its input and retries with corrected credentials (%s)",
    async (reason) => {
      setRooms([savedRoom("previous", 20)]);
      const actions = setup();
      fixture.join.mockRejectedValueOnce(new Error(reason));
      fixture.open.mockImplementationOnce(async () => ({
        cancel: false,
      }));
      fixture.open.mockImplementationOnce(
        async (options) => {
          expect(options).toEqual({ retry: true });
          expect(appState.profile.roomId).toBe("room");
          expect(appState.profile.password).toBe(
            "saved-password",
          );
          expect(actions.busy()).toBe(true);
          await actions.edit();
          expect(fixture.open).toHaveBeenCalledTimes(2);
          setAppState("profile", "password", "corrected");
          return { cancel: false };
        },
      );
      await actions.edit();
      expect(fixture.join).toHaveBeenCalledTimes(2);
      expect(appState.profile.password).toBe("corrected");
      expect(fixture.error).toHaveBeenCalledOnce();
      expect(actions.busy()).toBe(false);
      expect(appState.message.conversations).toEqual([
        savedRoom("previous", 20),
      ]);
    },
  );

  it("lets the user close a failed new-room form without connecting again", async () => {
    const actions = setup();
    fixture.join.mockRejectedValueOnce(
      new Error("offline"),
    );
    fixture.open.mockResolvedValueOnce({ cancel: false });
    fixture.open.mockResolvedValueOnce({ cancel: true });
    await actions.edit();
    expect(fixture.open).toHaveBeenLastCalledWith({
      retry: true,
    });
    expect(fixture.join).toHaveBeenCalledOnce();
    expect(actions.busy()).toBe(false);
    expect(appState.message.conversations).toEqual([]);
  });

  it.each([
    new DOMException("Room changed", "AbortError"),
    new Error("Room is already open in another tab"),
  ])(
    "does not reopen a cancelled or conflicting new-room attempt (%s)",
    async (error) => {
      const actions = setup();
      fixture.join.mockRejectedValueOnce(error);
      await actions.edit();
      expect(fixture.open).toHaveBeenCalledOnce();
      expect(fixture.error).not.toHaveBeenCalled();
      expect(actions.busy()).toBe(false);
    },
  );

  it("keeps existing history unchanged when selecting a saved room fails", async () => {
    setRooms([savedRoom("room", 20)]);
    const actions = setup();
    fixture.join.mockRejectedValueOnce(
      new Error("incorrect password"),
    );
    await actions.edit();
    expect(fixture.open).toHaveBeenCalledOnce();
    expect(fixture.error).toHaveBeenCalledOnce();
    expect(appState.message.conversations).toEqual([
      savedRoom("room", 20),
    ]);
  });

  it("shows automatic recovery as busy and prevents concurrent manual connections", async () => {
    const actions = setup();
    setAppState(
      "session",
      "clientServiceStatus",
      "connecting",
    );
    expect(actions.busy()).toBe(true);
    await actions.join();
    await actions.edit();
    await actions.takeover();
    expect(fixture.open).not.toHaveBeenCalled();
    expect(fixture.join).not.toHaveBeenCalled();
    setAppState(
      "session",
      "clientServiceStatus",
      "disconnected",
    );
    expect(actions.busy()).toBe(false);
    await actions.takeover();
    expect(fixture.join).toHaveBeenCalledWith({
      takeover: true,
    });
  });
});

describe("room connection notifications", () => {
  it.each([
    [
      new Error(
        "[WebSocketClientService] connection timeout",
      ),
      "errors.connection_timeout",
    ],
    [
      new Error(
        "[WebSocketClientService] incorrect password",
      ),
      "errors.incorrect_password",
    ],
    [
      new Error(
        "[WebSocketClientService] internal join failure",
      ),
      "errors.connection_failed",
    ],
  ])(
    "shows a translated connection error for %s and allows retry",
    async (error, key) => {
      const actions = setup();
      fixture.join.mockRejectedValueOnce(error);
      await actions.join();
      expect(fixture.error).toHaveBeenCalledOnce();
      expect(fixture.error).toHaveBeenCalledWith(key);
      expect(actions.busy()).toBe(false);
      await actions.join();
      expect(fixture.join).toHaveBeenCalledTimes(2);
    },
  );
  it("does not notify when leaving or switching rooms cancels a pending join", async () => {
    const actions = setup();
    fixture.join.mockRejectedValueOnce(
      new DOMException("Room changed", "AbortError"),
    );
    await actions.join();
    expect(fixture.error).not.toHaveBeenCalled();
    expect(actions.busy()).toBe(false);
  });
});
