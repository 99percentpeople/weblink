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
let dispose: () => void;
const setup = () =>
  createRoot((cleanup) => {
    dispose = cleanup;
    return createRoomActions();
  });

beforeEach(() => {
  vi.resetAllMocks();
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
afterEach(() => dispose?.());

describe("shared room actions", () => {
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
    expect(fixture.error).toHaveBeenCalledWith("offline");
    await actions.join();
    expect(fixture.join).toHaveBeenCalledTimes(2);
    expect(appState.profile.roomId).toBe("room");
  });
});
