// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createSignal } from "solid-js";
import { RoomConnectionOverlay } from "@/components/app/room-connection-overlay";

const [conflict, setConflict] = createSignal(false);
const [busy, setBusy] = createSignal(false);
const takeover = vi.fn(() => setBusy(true));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({ roomConflict: conflict }),
}));
vi.mock("@/components/app/room-actions", () => ({
  useRoomActions: () => ({ busy, takeover }),
}));
afterEach(() => {
  cleanup();
  setConflict(false);
  setBusy(false);
  takeover.mockClear();
  vi.restoreAllMocks();
});

describe("room connection conflict overlay", () => {
  it("blocks dismissal, offers explicit takeover and stays until connected", async () => {
    vi.spyOn(window, "scrollTo").mockImplementation(
      () => {},
    );
    const style = document.createElement("style");
    style.textContent =
      "* { animation-name: none !important; }";
    document.head.append(style);
    render(() => <RoomConnectionOverlay />);
    expect(screen.queryByRole("dialog")).toBeNull();
    setConflict(true);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAccessibleName(
      "room_connection.title",
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "room_connection.switch_here",
      }),
    );
    expect(takeover).toHaveBeenCalledOnce();
    expect(
      screen.getByRole("button", {
        name: "room_connection.switching",
      }),
    ).toBeDisabled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    setBusy(false);
    expect(
      screen.getByRole("button", {
        name: "room_connection.switch_here",
      }),
    ).toBeEnabled();
    setConflict(false);
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).toBeNull(),
    );
    style.remove();
  });
});
