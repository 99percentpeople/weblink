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
import { createSignal } from "solid-js";
import { PeerSpeedTest } from "@/components/peer-speed-test";
import { useAppState } from "@/libs/state/app-state-context";
import type { SpeedTestState } from "@/libs/services/speed-test-service";
import { SpeedTestError } from "@/libs/core/speed-test-protocol";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: vi.fn(),
}));

const start = vi.fn();
const cancel = vi.fn();
const approve = vi.fn();
const decline = vi.fn();
let update: (state: SpeedTestState) => void;
beforeEach(() => {
  vi.resetAllMocks();
  start.mockResolvedValue(undefined);
  const [state, setState] = createSignal<SpeedTestState>({
    status: "idle",
    peerId: null,
  });
  update = setState;
  vi.mocked(useAppState).mockReturnValue({
    speedTestState: state,
    getSpeedTestState: (peerId: string | null) =>
      state().peerId === peerId ? state() : undefined,
    startSpeedTest: start,
    cancelSpeedTest: cancel,
    approveSpeedTest: approve,
    declineSpeedTest: decline,
  } as unknown as ReturnType<typeof useAppState>);
});
afterEach(cleanup);

describe("peer speed test panel", () => {
  it("starts against the selected client, without any file input", async () => {
    const { container } = render(() => (
      <PeerSpeedTest clientId="peer" connected />
    ));
    expect(
      screen.getByText("speed_test.traffic_notice"),
    ).toBeInTheDocument();
    expect(
      container.querySelector('input[type="file"]'),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: "speed_test.start",
      }),
    );
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("peer"),
    );
    expect(
      screen.queryByText("speed_test.traffic_notice"),
    ).toBeNull();
    expect(
      screen.queryByText("speed_test.background_notice"),
    ).toBeNull();
  });

  it("disables testing while offline", () => {
    render(() => (
      <PeerSpeedTest clientId="peer" connected={false} />
    ));
    expect(
      screen.getByRole("button", {
        name: "speed_test.start",
      }),
    ).toBeDisabled();
    expect(
      screen.getByText("speed_test.errors.offline"),
    ).toBeInTheDocument();
  });

  it("shows the phase and cancels only this peer's active test", () => {
    update({
      peerId: "peer",
      status: "running",
      progress: { phase: "upload", bytes: 1024 * 1024 },
    });
    render(() => (
      <PeerSpeedTest clientId="peer" connected />
    ));
    expect(
      screen.queryByRole("button", {
        name: "speed_test.start",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("meter", {
        name: "speed_test.phases.upload: 0.00 Mbps",
      }),
    ).toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "speed_test.cancel",
      }),
    );
    expect(cancel).toHaveBeenCalledWith("peer");
  });

  it("lets the receiving peer approve or decline instead of only waiting", () => {
    update({
      id: "incoming",
      peerId: "peer",
      status: "running",
      incoming: true,
      progress: { phase: "approval", bytes: 0 },
    });
    render(() => (
      <PeerSpeedTest clientId="peer" connected />
    ));
    expect(
      screen.getByText(
        "speed_test.phases.approval_incoming",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "speed_test.cancel",
      }),
    ).toBeNull();

    fireEvent.click(
      screen.getByRole("button", {
        name: "speed_test.accept",
      }),
    );
    expect(approve).toHaveBeenCalledWith("peer");

    fireEvent.click(
      screen.getByRole("button", {
        name: "speed_test.decline",
      }),
    );
    expect(decline).toHaveBeenCalledWith("peer");
  });

  it("does not display another peer's results", () => {
    update({
      peerId: "other",
      status: "running",
      progress: { phase: "download", bytes: 1 },
    });
    render(() => (
      <PeerSpeedTest clientId="peer" connected />
    ));
    expect(
      screen.getByText("speed_test.errors.busy"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "speed_test.cancel",
      }),
    ).toBeNull();
  });

  it("shows a completed direction while the other direction is still running", () => {
    update({
      peerId: "peer",
      status: "running",
      progress: { phase: "download", bytes: 0 },
      measurements: {
        upload: {
          bytes: 2_000_000,
          durationMs: 2000,
          bytesPerSecond: 1_000_000,
        },
      },
    });
    render(() => (
      <PeerSpeedTest clientId="peer" connected />
    ));
    expect(screen.getByText("8.00")).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "speed_test.upload",
      }),
    ).toBeInTheDocument();
    expect(screen.getByRole("meter")).toBeInTheDocument();
  });

  it("shows measured decimal Mbps and binary MiB/s in both directions", () => {
    update({
      peerId: "peer",
      status: "done",
      result: {
        upload: {
          bytes: 2_000_000,
          durationMs: 2000,
          bytesPerSecond: 1_000_000,
        },
        download: {
          bytes: 4_000_000,
          durationMs: 2000,
          bytesPerSecond: 2_000_000,
        },
        completedAt: Date.now(),
      },
    });
    render(() => (
      <PeerSpeedTest clientId="peer" connected />
    ));
    expect(screen.getByRole("status")).toHaveTextContent(
      "8.00 Mbps / 0.95 MiB/s",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "16.00 Mbps / 1.91 MiB/s",
    );
    expect(screen.queryByRole("meter")).toBeNull();
    expect(
      screen.getByRole("img", {
        name: "speed_test.download",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("img", {
        name: "speed_test.upload",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("speed_test.result_note"),
    ).toBeInTheDocument();
  });

  it("explains unsupported peers instead of displaying a fake zero speed", () => {
    update({
      peerId: "peer",
      status: "error",
      error: "unsupported",
    });
    render(() => (
      <PeerSpeedTest clientId="peer" connected />
    ));
    expect(
      screen.getByText("speed_test.errors.unsupported"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Mbps/)).toBeNull();
  });

  it("reports a busy failure from starting a test", async () => {
    start.mockRejectedValue(new SpeedTestError("busy"));
    render(() => (
      <PeerSpeedTest clientId="peer" connected />
    ));
    fireEvent.click(
      screen.getByRole("button", {
        name: "speed_test.start",
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("speed_test.errors.busy"),
      ).toBeInTheDocument(),
    );
  });
});
