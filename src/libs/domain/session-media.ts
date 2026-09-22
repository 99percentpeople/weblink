export interface SessionMediaCodecOptions {
  preferredVideoCodec: string | null;
  preferredAudioCodec: string | null;
}

export interface PeerSessionMediaOptions {
  targetClientId(): string;
  getPeerConnection(): RTCPeerConnection | null;
  getCodecOptions(): SessionMediaCodecOptions;
  notifyStreamState(): void;
  renegotiate(): void | Promise<void>;
  onRemoteStreamChange(stream: MediaStream | null): void;
}

export class PeerSessionMediaController {
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private streamStateNotified = false;

  constructor(
    private readonly options: PeerSessionMediaOptions,
  ) {}

  private notifyLocalStreamState(
    stream: MediaStream | null,
  ): void {
    if (!stream) {
      this.streamStateNotified = false;
      return;
    }
    if (this.streamStateNotified) return;
    this.streamStateNotified = true;
    this.options.notifyStreamState();
  }

  private applyPreferredCodecPreferences(
    pc: RTCPeerConnection,
  ): void {
    if (typeof RTCRtpSender === "undefined") return;
    if (!("getCapabilities" in RTCRtpSender)) return;

    const orderCodecs = (
      codecs: any[],
      preferredMimeType: string,
    ) => {
      if (!preferredMimeType) return codecs;

      const normalizedPreferred = preferredMimeType
        .trim()
        .toLowerCase();
      const preferred = codecs.filter(
        (codec) =>
          codec.mimeType.trim().toLowerCase() ===
          normalizedPreferred,
      );
      if (preferred.length === 0) return codecs;

      const preferredPayloadTypes = new Set<number>();
      for (const codec of preferred) {
        const payloadType = (codec as any)
          .preferredPayloadType;
        if (typeof payloadType === "number") {
          preferredPayloadTypes.add(payloadType);
        }
      }

      const rtxForPreferred = codecs.filter((codec) => {
        if (
          codec.mimeType.trim().toLowerCase() !==
          "video/rtx"
        ) {
          return false;
        }
        const fmtp = (codec as any).sdpFmtpLine as
          | string
          | undefined;
        if (!fmtp) return false;
        const match = fmtp.match(/\bapt=(\d+)\b/);
        if (!match) return false;
        const apt = Number(match[1]);
        return (
          !Number.isNaN(apt) &&
          preferredPayloadTypes.has(apt)
        );
      });

      const preferredSet = new Set(preferred);
      const rtxSet = new Set(rtxForPreferred);
      const rest = codecs.filter(
        (codec) =>
          !preferredSet.has(codec) && !rtxSet.has(codec),
      );
      return [...preferred, ...rtxForPreferred, ...rest];
    };

    const applyForKind = (
      kind: "audio" | "video",
      preferredMimeType: string,
    ) => {
      if (!preferredMimeType) return;

      const codecs =
        RTCRtpSender.getCapabilities(kind)?.codecs;
      if (!codecs || codecs.length === 0) return;

      const ordered = orderCodecs(
        codecs,
        preferredMimeType,
      );

      for (const transceiver of pc.getTransceivers()) {
        const transceiverKind =
          transceiver.sender.track?.kind ??
          transceiver.receiver.track?.kind;
        if (transceiverKind !== kind) continue;
        if (!("setCodecPreferences" in transceiver))
          continue;

        try {
          transceiver.setCodecPreferences(ordered);
        } catch (error) {
          console.warn(
            `[PeerSession] setCodecPreferences failed for ${kind}:`,
            error,
          );
        }
      }
    };

    const { preferredVideoCodec, preferredAudioCodec } =
      this.options.getCodecOptions();

    applyForKind("video", preferredVideoCodec ?? "");
    applyForKind("audio", preferredAudioCodec ?? "");
  }

  private handleRemoteTrack(
    event: RTCTrackEvent,
    signal: AbortSignal,
  ): void {
    const stream = event.streams.at(0);
    if (!stream) {
      console.warn(
        `[PeerSession] client ${this.options.targetClientId()} add track ${event.track.id} stream is null`,
      );
      return;
    }

    console.log(
      `[PeerSession] client ${this.options.targetClientId()} add track ${event.track.id} stream ${stream.id}`,
    );

    const receiver = event.receiver;
    if ("jitterBufferTarget" in receiver) {
      (receiver as any).jitterBufferTarget = 0;
    }
    if ("playoutDelayHint" in receiver) {
      (receiver as any).playoutDelayHint = 0;
    }

    const track = event.track;
    track.addEventListener(
      "ended",
      () => {
        if (!this.remoteStream) return;
        this.remoteStream.removeTrack(track);
        this.options.onRemoteStreamChange(
          this.remoteStream,
        );
      },
      { once: true },
    );

    if (this.remoteStream) {
      if (stream.id === this.remoteStream.id) {
        this.remoteStream.addTrack(track);
        this.options.onRemoteStreamChange(
          this.remoteStream,
        );
        return;
      }

      const previous = this.remoteStream;
      for (const previousTrack of previous.getTracks()) {
        previous.removeTrack(previousTrack);
        previousTrack.stop();
      }
      this.remoteStream = null;
    }

    stream.addEventListener(
      "removetrack",
      (removeEvent) => {
        console.log(
          `[PeerSession] client ${this.options.targetClientId()} removetrack`,
          removeEvent.track.id,
        );
        if (stream.getTracks().length === 0) {
          this.remoteStream = null;
        }
        this.options.onRemoteStreamChange(
          this.remoteStream,
        );
      },
      { signal },
    );

    this.remoteStream = stream;
    this.options.onRemoteStreamChange(stream);
  }

  bindConnection(
    pc: RTCPeerConnection,
    signal: AbortSignal,
  ): void {
    pc.addEventListener(
      "track",
      (event) => this.handleRemoteTrack(event, signal),
      { signal },
    );

    if (this.localStream) {
      const stream = this.localStream;
      this.notifyLocalStreamState(stream);
      for (const track of stream.getTracks()) {
        pc.addTrack(track, stream);
      }
    } else {
      pc.addTransceiver("video", {
        direction: "recvonly",
      });
      pc.addTransceiver("audio", {
        direction: "recvonly",
      });
    }

    this.applyPreferredCodecPreferences(pc);
  }

  private removeStream(): void {
    console.log(
      `[PeerSession] client ${this.options.targetClientId()} removeStream`,
    );

    const localStream = this.localStream;
    if (localStream) {
      for (const track of localStream.getTracks()) {
        localStream.removeTrack(track);
        track.stop();
      }
      this.localStream = null;
    }

    const pc = this.options.getPeerConnection();
    if (!pc) {
      console.log(
        `[PeerSession] client ${this.options.targetClientId()} peer connection is null, skip remove stream`,
      );
      return;
    }

    for (const sender of pc.getSenders()) {
      if (sender.track) {
        pc.removeTrack(sender);
      }
    }

    void this.options.renegotiate();
  }

  setStream(stream: MediaStream | null): void {
    console.log(
      `[PeerSession] client ${this.options.targetClientId()} setStream`,
      stream,
    );

    if (!stream) {
      this.removeStream();
      this.notifyLocalStreamState(null);
      return;
    }

    if (this.localStream) {
      if (this.localStream.id === stream.id) {
        console.log(
          `[PeerSession] client ${this.options.targetClientId()} stream is same, skip setStream`,
        );
        return;
      }
      this.removeStream();
    }

    this.localStream = stream;
    this.notifyLocalStreamState(stream);

    let senders: RTCRtpSender[] = [];

    stream.addEventListener("addtrack", (event) => {
      const sender = this.options
        .getPeerConnection()
        ?.addTrack(event.track, stream);
      if (sender) {
        senders.push(sender);
      }
    });

    stream.addEventListener("removetrack", (event) => {
      const index = senders.findIndex(
        (sender) => sender.track?.id === event.track.id,
      );
      if (index === -1) return;

      const [sender] = senders.splice(index, 1);
      const pc = this.options.getPeerConnection();
      if (!sender || !pc) return;
      pc.removeTrack(sender);
    });

    const pc = this.options.getPeerConnection();
    if (!pc) {
      console.log(
        `[PeerSession] client ${this.options.targetClientId()} peer connection is null, skip add track`,
      );
      return;
    }

    senders.push(
      ...stream.getTracks().map((track) => {
        track.addEventListener("ended", () => {
          console.log(
            "[PeerSession] track ended, remove track from peer connection",
            track.id,
          );
          const index = senders.findIndex(
            (sender) => sender.track?.id === track.id,
          );
          if (index !== -1) {
            pc.removeTrack(senders[index]);
            senders.splice(index, 1);
          }
        });

        console.log(
          `[PeerSession] client ${this.options.targetClientId()} add track`,
          track.id,
        );

        return pc.addTrack(track, stream);
      }),
    );

    this.applyPreferredCodecPreferences(pc);
    void this.options.renegotiate();
  }

  resetConnection(): void {
    this.streamStateNotified = false;

    if (!this.remoteStream) return;

    for (const track of this.remoteStream.getTracks()) {
      track.stop();
    }
    this.remoteStream = null;
  }
}
