// @vitest-environment jsdom
import {
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  SpeedTestService,
  type SpeedTestState,
} from "@/libs/application/speed-test-service";
import {
  SpeedTestError,
  SPEED_TEST_PROTOCOL,
  type SpeedTestResult,
} from "@/libs/domain/speed-test-protocol";
import type { SpeedTestOptions } from "@/libs/domain/speed-test";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  run: vi.fn(),
}));
vi.mock("@/libs/domain/speed-test", () => ({
  createSpeedTestChannel: mocks.create,
  runSpeedTest: mocks.run,
}));

function fixture() {
  const pc = Object.assign(new EventTarget(), {
    connectionState: "connected",
    sctp: { maxMessageSize: 8192 },
  });
  const channel = {
    protocol: SPEED_TEST_PROTOCOL,
    readyState: "open",
    send: vi.fn(),
    close: vi.fn(),
  };
  const states: SpeedTestState[] = [];
  const busy = vi.fn(() => false);
  const approve = vi.fn(async () => true);
  const service = new SpeedTestService({
    getConnection: () => pc as unknown as RTCPeerConnection,
    isBusy: busy,
    approve,
    onState: (state) => states.push(state),
  });
  mocks.create.mockReturnValue(channel);
  return { service, pc, channel, states, busy, approve };
}

beforeEach(() => vi.resetAllMocks());

describe("speed test service", () => {
  it("reports progress/results and forwards the negotiated message size", async () => {
    const { service, states } = fixture();
    const measurement = {
      bytes: 100,
      durationMs: 10,
      bytesPerSecond: 10000,
    };
    const result: SpeedTestResult = {
      upload: measurement,
      download: measurement,
      completedAt: 123,
    };
    mocks.run.mockImplementation(
      async (
        _channel: unknown,
        _role: unknown,
        options: SpeedTestOptions,
      ) => {
        options.onProgress?.({
          phase: "upload",
          bytes: 100,
        });
        options.onMeasurement?.("upload", measurement);
        options.onProgress?.({
          phase: "download",
          bytes: 0,
        });
        return result;
      },
    );
    await service.start("peer");
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.run.mock.calls[0][2].maxMessageSize).toBe(
      8192,
    );
    expect(states).toContainEqual(
      expect.objectContaining({
        status: "running",
        peerId: "peer",
        progress: { phase: "upload", bytes: 100 },
      }),
    );
    expect(states).toContainEqual(
      expect.objectContaining({
        status: "running",
        peerId: "peer",
        progress: { phase: "download", bytes: 0 },
        measurements: { upload: measurement },
      }),
    );
    expect(states.at(-1)).toMatchObject({
      status: "done",
      peerId: "peer",
      result,
    });
  });

  it("does not start a test during file transfer", async () => {
    const { service, busy } = fixture();
    busy.mockReturnValue(true);
    await expect(
      service.start("peer"),
    ).rejects.toMatchObject({ code: "busy" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects an offline peer before creating a channel", async () => {
    const { service, pc } = fixture();
    pc.connectionState = "closed";
    await expect(
      service.start("peer"),
    ).rejects.toMatchObject({ code: "offline" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("prevents overlapping diagnostics and rejects an incoming test while busy", async () => {
    const { service, pc } = fixture();
    let finish!: (result: unknown) => void;
    mocks.run.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const pending = service.start("first");
    await expect(
      service.start("second"),
    ).rejects.toMatchObject({ code: "busy" });
    const incoming = {
      protocol: SPEED_TEST_PROTOCOL,
      readyState: "open",
      send: vi.fn(),
      close: vi.fn(),
    };
    service.handleChannel(
      "second",
      pc as unknown as RTCPeerConnection,
      incoming as unknown as RTCDataChannel,
    );
    expect(incoming.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "reject", reason: "busy" }),
    );
    expect(incoming.close).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledTimes(1);
    finish({});
    await pending;
  });

  it("routes incoming tests through approval and leaves file channels alone", async () => {
    const { service, pc, channel, approve, states } =
      fixture();
    mocks.run.mockImplementation(
      async (
        _channel: unknown,
        role: unknown,
        options: SpeedTestOptions,
      ) => {
        expect(role).toBe("responder");
        await options.approve!(options.signal!);
        throw new SpeedTestError("declined");
      },
    );
    service.handleChannel(
      "peer",
      pc as unknown as RTCPeerConnection,
      {
        ...channel,
        protocol: "transfer",
      } as unknown as RTCDataChannel,
    );
    expect(mocks.run).not.toHaveBeenCalled();
    service.handleChannel(
      "peer",
      pc as unknown as RTCPeerConnection,
      channel as unknown as RTCDataChannel,
    );
    await vi.waitFor(() =>
      expect(states.at(-1)?.status).toBe("error"),
    );
    expect(approve).toHaveBeenCalledWith(
      "peer",
      expect.any(AbortSignal),
    );
    expect(states.at(-1)).toMatchObject({
      incoming: true,
      error: "declined",
    });
  });

  it("cancels on disconnect and allows another test after cleanup", async () => {
    const { service, pc, states } = fixture();
    mocks.run.mockImplementation(
      (
        _channel: unknown,
        _role: unknown,
        options: SpeedTestOptions,
      ) =>
        new Promise((_resolve, reject) =>
          options.signal!.addEventListener("abort", () =>
            reject(options.signal!.reason),
          ),
        ),
    );
    const pending = service.start("peer");
    pc.connectionState = "disconnected";
    pc.dispatchEvent(new Event("connectionstatechange"));
    await pending;
    expect(states.at(-1)).toMatchObject({
      status: "error",
      error: "closed",
    });
    pc.connectionState = "connected";
    mocks.run.mockResolvedValue({});
    await service.start("peer");
    expect(states.at(-1)?.status).toBe("done");
  });

  it("only cancels the selected peer and disposal suppresses stale state updates", async () => {
    const { service, states } = fixture();
    let signal!: AbortSignal;
    mocks.run.mockImplementation(
      (
        _channel: unknown,
        _role: unknown,
        options: SpeedTestOptions,
      ) => {
        signal = options.signal!;
        return new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () =>
            reject(signal.reason),
          ),
        );
      },
    );
    const pending = service.start("peer");
    service.cancel("other");
    expect(signal.aborted).toBe(false);
    const before = states.length;
    service.dispose();
    await pending;
    expect(signal.aborted).toBe(true);
    expect(states).toHaveLength(before);
    await expect(
      service.start("peer"),
    ).rejects.toMatchObject({ code: "closed" });
  });
});
