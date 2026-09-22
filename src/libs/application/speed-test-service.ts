import {
  createSpeedTestChannel,
  runSpeedTest,
} from "../core/speed-test";
import {
  SPEED_TEST_PROTOCOL,
  SpeedTestError,
  type SpeedTestErrorCode,
  type SpeedMeasurement,
  type SpeedTestProgress,
  type SpeedTestResult,
} from "../core/speed-test-protocol";
import type { ClientID } from "@/libs/core/ids";

export interface SpeedTestState {
  /** Stable identity across progress updates and view remounts. */
  id?: string;
  startedAt?: number;
  status:
    | "idle"
    | "running"
    | "done"
    | "cancelled"
    | "error";
  peerId: ClientID | null;
  incoming?: boolean;
  progress?: SpeedTestProgress;
  measurements?: Partial<
    Record<"upload" | "download", SpeedMeasurement>
  >;
  result?: SpeedTestResult;
  error?: SpeedTestErrorCode;
}

interface SpeedTestServiceOptions {
  getConnection: (
    peerId: ClientID,
  ) => RTCPeerConnection | null | undefined;
  isBusy: () => boolean;
  approve: (
    peerId: ClientID,
    signal: AbortSignal,
  ) => Promise<boolean>;
  onState: (state: SpeedTestState) => void;
}

/** One diagnostic at a time, independent of file caches/transfer managers. */
export class SpeedTestService {
  private active?: {
    peerId: ClientID;
    controller: AbortController;
  };
  private disposed = false;

  constructor(
    private readonly options: SpeedTestServiceOptions,
  ) {}

  async start(peerId: ClientID): Promise<void> {
    if (this.disposed) throw new SpeedTestError("closed");
    if (this.active || this.options.isBusy())
      throw new SpeedTestError("busy");
    const pc = this.options.getConnection(peerId);
    if (!pc || pc.connectionState !== "connected")
      throw new SpeedTestError("offline");
    const channel = createSpeedTestChannel(pc);
    await this.execute(peerId, pc, channel, false);
  }

  handleChannel(
    peerId: ClientID,
    pc: RTCPeerConnection | null,
    channel: RTCDataChannel,
  ): void {
    if (channel.protocol !== SPEED_TEST_PROTOCOL) return;
    if (
      this.disposed ||
      !pc ||
      this.active ||
      this.options.isBusy()
    ) {
      // Graceful shutdown flushes the small rejection before closing. Never
      // replace an active diagnostic or attach file-transfer listeners here.
      try {
        if (channel.readyState === "open") {
          channel.send(
            JSON.stringify({
              type: "reject",
              reason: "busy",
            }),
          );
        }
      } finally {
        channel.close();
      }
      return;
    }
    void this.execute(peerId, pc, channel, true);
  }

  cancel(peerId?: ClientID): void {
    if (
      peerId !== undefined &&
      this.active?.peerId !== peerId
    )
      return;
    this.active?.controller.abort(
      new SpeedTestError("cancelled"),
    );
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
  }

  private async execute(
    peerId: ClientID,
    pc: RTCPeerConnection,
    channel: RTCDataChannel,
    incoming: boolean,
  ): Promise<void> {
    const run = {
      id: crypto.randomUUID(),
      startedAt: Date.now(),
      peerId,
      controller: new AbortController(),
    };
    this.active = run;
    let progress: SpeedTestProgress = {
      phase: "connecting",
      bytes: 0,
    };
    let measurements:
      | SpeedTestState["measurements"]
      | undefined;
    const update = (
      state: Omit<SpeedTestState, "peerId" | "incoming">,
    ) => {
      if (this.active === run && !this.disposed)
        this.options.onState({
          ...state,
          ...(measurements
            ? { measurements: { ...measurements } }
            : {}),
          id: run.id,
          startedAt: run.startedAt,
          peerId,
          incoming,
        });
    };
    const onConnectionChange = () => {
      if (
        ["closed", "failed", "disconnected"].includes(
          pc.connectionState,
        )
      ) {
        run.controller.abort(new SpeedTestError("closed"));
      }
    };
    pc.addEventListener(
      "connectionstatechange",
      onConnectionChange,
    );
    update({
      status: "running",
      progress,
    });
    onConnectionChange();
    try {
      const result = await runSpeedTest(
        channel,
        incoming ? "responder" : "initiator",
        {
          signal: run.controller.signal,
          maxMessageSize: pc.sctp?.maxMessageSize,
          approve: (signal) =>
            this.options.approve(peerId, signal),
          onProgress: (nextProgress) => {
            progress = nextProgress;
            update({ status: "running", progress });
          },
          onMeasurement: (direction, measurement) => {
            measurements = {
              ...(measurements ?? {}),
              [direction]: measurement,
            };
            update({ status: "running", progress });
          },
        },
      );
      update({ status: "done", result });
    } catch (error) {
      const code =
        error instanceof SpeedTestError
          ? error.code
          : "failed";
      update({
        status:
          code === "cancelled" ? "cancelled" : "error",
        error: code,
      });
    } finally {
      pc.removeEventListener(
        "connectionstatechange",
        onConnectionChange,
      );
      if (this.active === run) this.active = undefined;
    }
  }
}
