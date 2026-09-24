import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot } from "solid-js";
import { createRoomActions } from "@/components/app/room-actions";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

const fixture = vi.hoisted(() => ({
  open: vi.fn(),
  join: vi.fn(),
  error: vi.fn(),
}));
vi.mock("@/components/dialogs/join-dialog", () => ({
  createRoomDialog: () => ({ open: fixture.open }),
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({ joinRoom: fixture.join }),
}));
vi.mock("solid-sonner", () => ({
  toast: { error: fixture.error },
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
let dispose: () => void;
const setup = () =>
  createRoot((cleanup) => {
    dispose = cleanup;
    return createRoomActions();
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  setAppState("profile", {
    name: "Alice",
    roomId: "room",
    initalJoin: false,
  });
  setAppState(
    "session",
    "clientServiceStatus",
    "disconnected",
  );
  fixture.open.mockResolvedValue({ cancel: false });
  fixture.join.mockResolvedValue(undefined);
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
  it("keeps a closed settings dialog disconnected and joins a configured room directly", async () => {
    const actions = setup();
    fixture.open.mockResolvedValueOnce({ cancel: true });
    await actions.edit();
    expect(fixture.open).toHaveBeenCalledOnce();
    expect(fixture.join).not.toHaveBeenCalled();
    await actions.join();
    expect(fixture.open).toHaveBeenCalledOnce();
    expect(fixture.join).toHaveBeenCalledOnce();
  });

  it("connects when the settings dialog's Connect action is selected", async () => {
    const actions = setup();
    await actions.edit();
    expect(fixture.open).toHaveBeenCalledOnce();
    expect(fixture.join).toHaveBeenCalledOnce();
    expect(actions.busy()).toBe(false);
  });

  it("waits for initial information and honors cancellation", async () => {
    const actions = setup();
    setAppState("profile", "initalJoin", true);
    fixture.open.mockResolvedValueOnce({ cancel: true });
    await actions.join();
    expect(fixture.join).not.toHaveBeenCalled();
    await actions.join();
    expect(fixture.join).toHaveBeenCalledOnce();
  });

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
