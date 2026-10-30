import { createSignal } from "solid-js";
import type {
  NativeScreenReceive,
  NativeReceiveConnection,
  NativeReceiveEvent,
} from "@weblink/platform";
import {
  ScreenReceiver,
  type ScreenReceiveConnection,
  type ScreenReceiverFactory,
} from "../domain/native-screen/receiver";
import { browserDecodeCapabilities } from "../domain/media-codecs";
import { monitorScreenDecode } from "../domain/native-screen/decode-monitor";
import {
  ScreenDecodeError,
  ScreenDecodeStallError,
} from "../domain/native-screen/errors";
import { readVideoStatsReport } from "../domain/video-stats";
import {
  CONTROL_CHANNEL,
  POINTER_CHANNEL,
  type ControlDataChannel,
  type RemotePointer,
} from "../domain/remote-control/pointer";

/** Capability discovery and failure policy belong to the application, not the
 * browser receiver. A failed native codec is suppressed for this app session. */
export class NativeScreenReceiveService {
  private readonly nativeCodecs = createSignal<string[]>(
    [],
  );
  private readonly disabled = new Set<string>();
  private busy = false;
  readonly ready: Promise<void>;
  constructor(
    private readonly native?: NativeScreenReceive,
  ) {
    this.ready = native
      ? native
          .codecs()
          .then((codecs) => {
            this.nativeCodecs[1]([
              ...new Set(
                codecs.map((c) => c.toLowerCase()),
              ),
            ]);
          })
          .catch((error) =>
            console.warn(
              "Native receiver discovery failed",
              error,
            ),
          )
      : Promise.resolve();
  }
  capabilities() {
    const browser = browserDecodeCapabilities();
    const native = this.nativeCodecs[0]();
    return {
      audio: browser.audio,
      video: native.length
        ? [
            ...new Set([
              ...(browser.video ?? []),
              ...native,
            ]),
          ]
        : browser.video,
    };
  }
  readonly createReceiver: ScreenReceiverFactory = (
    sdp,
    ...args
  ) => {
    const section =
      sdp
        .split(/(?=^m=)/m)
        .find((s) => s.startsWith("m=video ")) ?? "";
    const codecs = [
      ...section.matchAll(/^a=rtpmap:\d+ ([^/\s]+)\//gim),
    ].map((m) => `video/${m[1].toLowerCase()}`);
    const codec = codecs.find((c) =>
      this.nativeCodecs[0]().includes(c),
    );
    if (
      !this.native ||
      !codec ||
      this.disabled.has(codec) ||
      this.busy ||
      !args[3]
    )
      return new ScreenReceiver(...args);
    this.busy = true;
    return new NativeReceiver(
      this.native,
      args,
      () => {
        this.busy = false;
      },
      () => {
        this.disabled.add(codec);
        // This first native backend is a single receive lane. A failed backend
        // returns subsequent offers to the established browser path for the
        // session, including another codec after HEVC rejection.
        this.nativeCodecs[1]([]);
        // Retry the format through the browser when it can receive it; otherwise
        // the existing sender policy negotiates another mutually supported codec.
        return browserDecodeCapabilities().video?.includes(
          codec,
        )
          ? new ScreenDecodeStallError()
          : new ScreenDecodeError();
      },
    );
  };
}

class NativeReceiver
  extends EventTarget
  implements ScreenReceiveConnection
{
  private readonly lifetime = new AbortController();
  private connection?: NativeReceiveConnection;
  private readonly opening: Promise<NativeReceiveConnection>;
  private currentStream = new MediaStream();
  private candidates: RTCIceCandidateInit[] = [];
  private remoteReady = false;
  private stopMonitor?: () => void;
  private disconnectTimer?: ReturnType<typeof setTimeout>;
  private channels = new Map<
    string,
    NativeControlChannel
  >();
  connectionState: RTCPeerConnectionState = "new";
  private readonly changed: (
    stream: MediaStream | null,
  ) => void;
  private readonly failed: (error: Error) => void;
  private readonly candidate?: (
    candidate: RTCIceCandidateInit,
  ) => void;
  private readonly control?: RemotePointer;
  get stream() {
    return this.connection?.stream ?? this.currentStream;
  }
  constructor(
    native: NativeScreenReceive,
    [
      configuration,
      changed,
      failed,
      candidate,
      control,
    ]: ConstructorParameters<typeof ScreenReceiver>,
    private readonly released: () => void,
    private readonly rejectCodec: () => Error,
  ) {
    super();
    this.changed = changed;
    this.failed = failed;
    this.candidate = candidate;
    this.control = control;
    control?.addEventListener(
      "transporterror",
      () =>
        this.fail(
          new Error("Native control connection ended"),
        ),
      { signal: this.lifetime.signal },
    );
    this.opening = native
      .open(
        configuration,
        (event) => this.event(event),
        this.lifetime.signal,
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
      this.candidate?.(event.candidate);
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
      this.changed(
        new MediaStream(this.stream.getTracks()),
      );
      this.dispatchEvent(new Event("track"));
    } else if (event.type === "channel") {
      if (
        !this.control ||
        ![CONTROL_CHANNEL, POINTER_CHANNEL].includes(
          event.label,
        )
      )
        return;
      let channel = this.channels.get(event.label);
      if (!channel) {
        channel = new NativeControlChannel(
          event.label,
          (data) =>
            this.opening.then((c) =>
              c.send(event.label, data),
            ),
        );
        this.channels.set(event.label, channel);
        this.control.bind(channel);
      }
      channel.state(event.state);
    } else if (event.type === "message")
      this.channels
        .get(event.label)
        ?.dispatchEvent(
          new MessageEvent("message", { data: event.data }),
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
      const failure = this.rejectCodec();
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
  getRecordingMediaSources() {
    return [];
  }
  monitorDecode(healthy: () => void) {
    this.stopMonitor?.();
    if (!this.lifetime.signal.aborted)
      this.stopMonitor = monitorScreenDecode(
        this,
        healthy,
        () => this.decodeFailed(),
        { maxProcessingDelayMs: 250 },
      );
  }
  decodeFailed() {
    if (!this.lifetime.signal.aborted)
      this.fail(this.rejectCodec());
  }
  private fail(error: Error) {
    if (this.lifetime.signal.aborted) return;
    this.close();
    this.failed(error);
  }
  close() {
    if (this.lifetime.signal.aborted) return;
    this.lifetime.abort();
    this.stopMonitor?.();
    clearTimeout(this.disconnectTimer);
    this.control?.close();
    this.channels.clear();
    this.candidates = [];
    this.connection?.close();
    this.connectionState = "closed";
    this.currentStream.getTracks().forEach((t) => t.stop());
    this.released();
    this.changed(null);
  }
}

class NativeControlChannel
  extends EventTarget
  implements ControlDataChannel
{
  readonly protocol: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime = null;
  readyState: RTCDataChannelState = "connecting";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  private sending: Promise<void> = Promise.resolve();
  constructor(
    readonly label: string,
    private readonly write: (data: string) => Promise<void>,
  ) {
    super();
    this.protocol = label;
    this.ordered = label === CONTROL_CHANNEL;
    this.maxRetransmits = this.ordered ? null : 0;
  }
  state(state: RTCDataChannelState) {
    if (state === this.readyState) return;
    this.readyState = state;
    if (state === "open" || state === "closed")
      this.dispatchEvent(
        new Event(state === "open" ? "open" : "close"),
      );
  }
  send(data: string) {
    if (this.readyState !== "open")
      throw new Error("Native channel closed");
    const bytes = new TextEncoder().encode(data).byteLength;
    if (this.bufferedAmount + bytes > 65536)
      throw new DOMException(
        "Native channel full",
        "OperationError",
      );
    this.bufferedAmount += bytes;
    // IPC handlers may run concurrently. Serialize submissions so the reliable
    // channel's ordered contract also holds before packets reach SCTP.
    this.sending = this.sending
      .then(() => {
        if (this.readyState === "open")
          return this.write(data);
      })
      .catch(() => {
        if (this.readyState === "open")
          this.dispatchEvent(new Event("error"));
      })
      .finally(() => {
        this.bufferedAmount -= bytes;
        if (
          this.bufferedAmount <=
            this.bufferedAmountLowThreshold &&
          this.readyState === "open"
        )
          this.dispatchEvent(
            new Event("bufferedamountlow"),
          );
      });
  }
  close() {
    this.state("closed");
  }
}
