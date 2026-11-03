import type {
  NativeMediaReceive,
  NativeReceiveConnection,
  NativeReceiveEvent,
} from "@weblink/platform";
import { monitorScreenDecode } from "../domain/native-screen/decode-monitor";
import { ScreenDecodeStallError } from "../domain/native-screen/errors";
import { readVideoStatsReport } from "../domain/video-stats";

export interface NativeReceiveData {
  listen(
    failed: (error: Error) => void,
    signal: AbortSignal,
  ): void;
  event(
    event: Extract<
      NativeReceiveEvent,
      { type: "channel" | "message" }
    >,
    send: (label: string, data: string) => Promise<void>,
  ): void;
  close(): void;
}

interface ReceiveOptions {
  source: "screen" | "camera";
  changed(stream: MediaStream | null): void;
  failed(error: Error): void;
  candidate?(value: RTCIceCandidateInit): void;
  released?(): void;
  rejectCodec(): Error;
  retryNativeDecode: boolean;
  data?: NativeReceiveData;
}

export class NativeMediaReceiver extends EventTarget {
  private readonly lifetime = new AbortController();
  private connection?: NativeReceiveConnection;
  private readonly opening: Promise<NativeReceiveConnection>;
  private currentStream = new MediaStream();
  private candidates: RTCIceCandidateInit[] = [];
  private remoteReady = false;
  private stopMonitor?: () => void;
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  connectionState: RTCPeerConnectionState = "new";
  get stream() {
    return this.connection?.stream ?? this.currentStream;
  }
  constructor(
    native: NativeMediaReceive,
    configuration: RTCConfiguration,
    private readonly options: ReceiveOptions,
  ) {
    super();
    options.data?.listen(
      (error) => this.fail(error),
      this.lifetime.signal,
    );
    this.opening = native
      .open(
        configuration,
        (event) => this.event(event),
        this.lifetime.signal,
        options.source,
      )
      .then((connection) => {
        if (this.lifetime.signal.aborted) {
          connection.close();
          throw new Error("Receiver closed");
        }
        this.connection = connection;
        return connection;
      });
    void this.opening.catch(() => {});
  }
  private event(event: NativeReceiveEvent) {
    if (this.lifetime.signal.aborted) return;
    if (event.type === "candidate")
      this.options.candidate?.(event.candidate);
    else if (event.type === "state") {
      this.connectionState = event.state;
      this.dispatchEvent(
        new Event("connectionstatechange"),
      );
      clearTimeout(this.disconnectTimer);
      if (
        event.state === "failed" ||
        event.state === "closed"
      )
        this.fail(
          new Error("Native receive connection ended"),
        );
      else if (event.state === "disconnected")
        this.disconnectTimer = setTimeout(
          () =>
            this.fail(
              new Error(
                "Native receive connection disconnected",
              ),
            ),
          8000,
        );
    } else if (event.type === "error") {
      console.warn("Native receive failed", event.error);
      this.decodeFailed();
    } else if (event.type === "track") {
      if (!this.connection) return;
      this.options.changed(
        new MediaStream(this.stream.getTracks()),
      );
      this.dispatchEvent(new Event("track"));
    } else
      this.options.data?.event(event, (label, data) =>
        this.opening.then((connection) =>
          connection.send(label, data),
        ),
      );
  }
  async answer(sdp: string) {
    try {
      const connection = await this.opening;
      const answer = await connection.answer(sdp);
      this.lifetime.signal.throwIfAborted();
      this.remoteReady = true;
      for (const candidate of this.candidates.splice(0))
        await connection.addIceCandidate(candidate);
      // Old non-trickle peers need gathered candidates in the answer. Native
      // reception is only selected for current trickle-capable screen sessions.
      return answer;
    } catch (error) {
      if (this.lifetime.signal.aborted) throw error;
      const failure = this.options.rejectCodec();
      this.close();
      throw failure;
    }
  }
  async addIceCandidate(candidate: RTCIceCandidateInit) {
    if (this.lifetime.signal.aborted) return;
    if (!this.remoteReady) {
      if (this.candidates.length >= 256)
        throw new Error("Too many native ICE candidates");
      this.candidates.push(candidate);
      return;
    }
    await (await this.opening).addIceCandidate(candidate);
  }
  async connected(audio = false) {
    await this.opening;
    const done = () =>
      this.connectionState === "connected" &&
      this.stream.getVideoTracks().length > 0 &&
      (!audio || this.stream.getAudioTracks().length > 0);
    if (this.lifetime.signal.aborted)
      throw new Error("Receiver closed");
    if (done()) return;
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timer);
        this.removeEventListener(
          "connectionstatechange",
          check,
        );
        this.removeEventListener("track", check);
        this.lifetime.signal.removeEventListener(
          "abort",
          aborted,
        );
        error ? reject(error) : resolve();
      };
      const check = () => {
        if (done()) finish();
      };
      const aborted = () =>
        finish(new Error("Receiver closed"));
      const timer = setTimeout(
        () =>
          finish(new Error("Native receiver timed out")),
        20000,
      );
      this.addEventListener("connectionstatechange", check);
      this.addEventListener("track", check);
      this.lifetime.signal.addEventListener(
        "abort",
        aborted,
        { once: true },
      );
      check();
    });
  }
  async getStats(): Promise<RTCStatsReport> {
    const stats = await (await this.opening).stats();
    return new Map(stats.map((s) => [s.id, s]));
  }
  async getVideoStats(track: MediaStreamTrack) {
    if (
      !this.stream.getVideoTracks().some((t) => t === track)
    )
      return [];
    return readVideoStatsReport(
      await this.getStats(),
      "receive",
    );
  }
  monitorDecode(healthy: () => void) {
    this.stopMonitor?.();
    if (!this.lifetime.signal.aborted)
      this.stopMonitor = monitorScreenDecode(
        this,
        healthy,
        () => {
          // Overload/stalls first recreate the native connection and request a
          // keyframe. The existing sender bounds retries and codec changes.
          if (this.options.retryNativeDecode)
            this.fail(new ScreenDecodeStallError());
          else this.decodeFailed();
        },
        { maxProcessingDelayMs: 250 },
      );
  }
  decodeFailed() {
    if (!this.lifetime.signal.aborted)
      this.fail(this.options.rejectCodec());
  }
  private fail(error: Error) {
    if (this.lifetime.signal.aborted) return;
    this.close();
    this.options.failed(error);
  }
  close() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.stopMonitor?.();
    clearTimeout(this.disconnectTimer);
    this.options.data?.close();
    this.candidates = [];
    this.connection?.close();
    this.connectionState = "closed";
    this.currentStream.getTracks().forEach((t) => t.stop());
    this.options.released?.();
    this.options.changed(null);
  }
}
