import {
  cameraPublication,
  cameraCodecs,
  type CameraSettings,
} from "../domain/camera-publication";
import { MediaPublicationSender } from "../domain/media-publication";
import {
  answerMediaOffer,
  type IncomingMedia,
} from "../domain/media-offer";
import {
  readMediaEnvelope,
  mediaSignal,
  type MediaSignal,
} from "../domain/media-signaling";
import type { MediaReceiverFactory } from "../domain/media-receiver";
import {
  ScreenDecodeError,
  ScreenDecodeStallError,
} from "../domain/native-screen/errors";
import type { PeerCapabilities } from "../domain/protocol/capabilities";
import type { VideoStatsBatch } from "../domain/video-stats";
import {
  getMeetingAudioSource,
  getMeetingVideoSourceKind,
} from "./meeting-media-service";

// Separate namespace on the existing authenticated, ordered media signaling channel.
const prefix = "camera ";
interface CameraPort {
  createReceiver: MediaReceiverFactory;
  accepts(): boolean;
  loadIceServers(): Promise<RTCIceServer[]>;
  relayOnly(): boolean;
  settings(): CameraSettings;
  changed(stream: MediaStream | null): void;
  captureEnded(): void;
  error(error: unknown): void;
}

export class MeetingCameraPeer {
  private channel?: RTCDataChannel;
  private listeners?: AbortController;
  private remote?: PeerCapabilities["meetingMedia"];
  private incoming?: IncomingMedia & { id: string };
  private outgoing?: {
    camera: MediaStreamTrack;
    mic?: MediaStreamTrack;
    sender: MediaPublicationSender;
    lifetime: AbortController;
  };
  constructor(private readonly port: CameraPort) {}

  setCapabilities(
    remote: PeerCapabilities["meetingMedia"],
  ) {
    this.remote = remote;
    if (!remote?.camera) this.stopSending();
    if (!remote || !this.port.accepts())
      this.stopReceiving();
    this.outgoing?.sender.refreshCodecs();
  }
  /** Only tracks assigned to this receiver leave the ordinary meeting connection. */
  route(stream: MediaStream | null): MediaStream | null {
    const live = (track: MediaStreamTrack) =>
      track.readyState !== "ended";
    const camera =
      this.remote?.camera &&
      stream
        ?.getVideoTracks()
        .find(
          (t) =>
            live(t) &&
            getMeetingVideoSourceKind(t) === "camera",
        );
    if (!camera || !stream) {
      this.stopSending();
      return stream;
    }
    const mic = stream
      .getAudioTracks()
      .find(
        (t) =>
          live(t) &&
          getMeetingAudioSource(t).kind === "microphone",
      );
    if (
      !cameraCodecs(
        this.remote?.camera ?? undefined,
        this.port.settings(),
        !!mic,
      )
    ) {
      this.stopSending();
      return stream;
    }
    if (
      this.outgoing?.camera !== camera ||
      this.outgoing.mic !== mic
    ) {
      this.stopSending();
      const lifetime = new AbortController();
      const sender: MediaPublicationSender =
        new MediaPublicationSender(
          cameraPublication(
            camera,
            mic,
            this.port.settings,
          ),
          {
            kind: "camera",
            ready: () =>
              this.channel?.readyState === "open" &&
              !!this.remote?.camera,
            selected: () =>
              this.outgoing?.sender === sender,
            trickleIce: () => true,
            decodeCapabilities: () =>
              this.remote?.camera ?? undefined,
            loadIceServers: this.port.loadIceServers,
            relayOnly: this.port.relayOnly,
            send: (signal) => this.send(signal),
            error: this.port.error,
          },
        );
      this.outgoing = { camera, mic, sender, lifetime };
      for (const track of mic ? [camera, mic] : [camera])
        track.addEventListener(
          "ended",
          this.port.captureEnded,
          { signal: lifetime.signal },
        );
    }
    void this.outgoing.sender.publish();
    const rest = stream
      .getTracks()
      .filter((t) => t !== camera && t !== mic);
    return rest.length ? new MediaStream(rest) : null;
  }
  get sender() {
    return this.outgoing?.sender;
  }
  private stopSending() {
    this.outgoing?.lifetime.abort();
    this.outgoing?.sender.dispose();
    this.outgoing = undefined;
  }
  private stopReceiving() {
    const incoming = this.incoming;
    if (!incoming) return;
    this.incoming = undefined;
    incoming.receiver?.close();
    this.port.changed(null);
  }
  private send(value: MediaSignal) {
    const channel = this.channel;
    if (channel?.readyState !== "open") return;
    const data = prefix + JSON.stringify(value);
    if (
      data.length > 65536 ||
      channel.bufferedAmount > 262144
    )
      throw new Error("Camera signaling overflow");
    channel.send(data);
  }
  bind(channel: RTCDataChannel) {
    if (this.channel === channel) return;
    this.disconnect();
    this.channel = channel;
    const { signal } = (this.listeners =
      new AbortController());
    channel.addEventListener(
      "message",
      ({ data }) => {
        if (
          typeof data !== "string" ||
          data.length > 65536 ||
          !data.startsWith(prefix)
        )
          return;
        const value = mediaSignal(
          readMediaEnvelope(data.slice(prefix.length)),
        );
        if (value)
          void this.handle(value).catch(this.port.error);
      },
      { signal },
    );
    const open = () => void this.sender?.publish();
    channel.addEventListener("open", open, { signal });
    channel.addEventListener(
      "close",
      () => this.disconnect(),
      { signal },
    );
    if (channel.readyState === "open") open();
  }
  disconnect() {
    this.listeners?.abort();
    this.channel = undefined;
    this.sender?.reset();
    this.stopReceiving();
  }
  dispose() {
    this.disconnect();
    this.stopSending();
  }
  decodeFailed(track: MediaStreamTrack) {
    this.receiverFor(track)?.decodeFailed();
  }
  private receiverFor(track: MediaStreamTrack) {
    const receiver = this.incoming?.receiver;
    return receiver?.stream
      .getVideoTracks()
      .some((video) => video === track)
      ? receiver
      : undefined;
  }
  async stats(
    track: MediaStreamTrack,
  ): Promise<VideoStatsBatch[]> {
    if (this.outgoing?.camera === track)
      return this.outgoing.sender.getVideoStats();
    const receiver = this.receiverFor(track);
    if (!receiver) return [];
    return [
      {
        key: receiver,
        direction: "receive",
        samples: await receiver.getVideoStats(track),
      },
    ];
  }
  private async handle(value: MediaSignal) {
    if (
      value.type === "candidate" &&
      value.id === this.incoming?.id
    ) {
      const incoming = this.incoming;
      if (incoming.receiver)
        await incoming.receiver.addIceCandidate(
          value.candidate,
        );
      else if (incoming.candidates.length < 256)
        incoming.candidates.push(value.candidate);
      return;
    }
    if (
      value.type === "candidate" ||
      value.type === "answer" ||
      value.type === "retry" ||
      value.type === "receiver-status"
    ) {
      await this.sender?.handle(value);
      return;
    }
    if (
      value.type === "stop" &&
      value.id === this.incoming?.id
    )
      this.stopReceiving();
    if (
      value.type !== "offer" ||
      value.trickleIce !== true ||
      value.control ||
      !this.remote ||
      !this.port.accepts() ||
      value.id === this.incoming?.id
    )
      return;
    // Camera connections carry one video and optionally its microphone. Data channels are screen-only.
    const media = value.sdp.match(/^m=\S+/gm) ?? [];
    if (
      media.filter((m) => m === "m=video").length !== 1 ||
      media.filter((m) => m === "m=audio").length > 1 ||
      media.some((m) => m !== "m=audio" && m !== "m=video")
    )
      return;
    this.stopReceiving();
    const incoming: IncomingMedia & { id: string } = {
      id: value.id,
      candidates: [],
    };
    this.incoming = incoming;
    const current = () =>
      this.incoming === incoming && this.port.accepts();
    const failed = (error: unknown) => {
      if (!current()) return;
      this.stopReceiving();
      this.port.error(error);
      this.send(
        error instanceof ScreenDecodeError
          ? {
              type: "receiver-status",
              id: value.id,
              state: "unsupported",
            }
          : {
              type: "retry",
              id: value.id,
              ...(error instanceof ScreenDecodeStallError
                ? { reason: "decode" }
                : {}),
            },
      );
    };
    try {
      await answerMediaOffer(
        value,
        incoming,
        {
          ...this.port,
          send: (message) => this.send(message),
        },
        current,
        (stream) => {
          if (!current()) return;
          this.port.changed(stream);
        },
        failed,
      );
    } catch (error) {
      failed(error);
    }
  }
}
