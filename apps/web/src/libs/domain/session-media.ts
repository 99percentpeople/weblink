import type {
  StreamAudioSource,
  StreamVideoSource,
} from "./protocol/messages";

export interface SessionMediaCodecOptions {
  preferredVideoCodec: string | null;
  preferredAudioCodec: string | null;
}

export type RemoteMediaTrackBinding = {
  trackId: string;
  mid: string;
};

export interface PeerSessionMediaOptions {
  targetClientId(): string;
  getPeerConnection(): RTCPeerConnection | null;
  getCodecOptions(): SessionMediaCodecOptions;
  getVideoSourceKind?(
    track: MediaStreamTrack,
  ): StreamVideoSource["kind"] | undefined;
  getAudioSource?(
    track: MediaStreamTrack,
  ):
    | { kind: "microphone" }
    | { kind: "screen"; videoTrack: MediaStreamTrack };
  notifyStreamState(
    videoSources: readonly StreamVideoSource[],
    audioSources: readonly StreamAudioSource[],
  ): void;
  onRemoteStreamChange(stream: MediaStream | null): void;
  onRemoteVideoTracksChange(
    bindings: readonly RemoteMediaTrackBinding[],
  ): void;
  onRemoteAudioTracksChange?(
    bindings: readonly RemoteMediaTrackBinding[],
  ): void;
}

export class PeerSessionMediaController {
  private localStream: MediaStream | null = null;
  private remoteStream: MediaStream | null = null;
  private streamStateNotified = false;
  private sourcesSignature = "";
  private localListeners: AbortController | null = null;
  private readonly localTrackListeners = new Map<
    MediaStreamTrack,
    AbortController
  >();
  private connectionListeners: AbortController | null =
    null;
  private senderConnection: RTCPeerConnection | null = null;
  private readonly senders = new Map<
    MediaStreamTrack,
    RTCRtpSender
  >();
  private readonly remoteTracks = new Map<
    MediaStreamTrack,
    {
      controller: AbortController;
      streams: Set<MediaStream>;
      transceiver: RTCRtpTransceiver;
    }
  >();
  private readonly remoteStreams = new Map<
    MediaStream,
    {
      controller: AbortController;
      tracks: Set<MediaStreamTrack>;
    }
  >();

  constructor(
    private readonly options: PeerSessionMediaOptions,
  ) {}

  private notifyLocalStreamState(
    stream: MediaStream | null,
  ): void {
    if (!stream) {
      this.streamStateNotified = false;
      this.sourcesSignature = "";
      return;
    }
    const pc = this.options.getPeerConnection();
    const transceivers = pc?.getTransceivers() ?? [];
    const midOf = (track: MediaStreamTrack) => {
      const sender = this.senders.get(track);
      return transceivers.find(
        (transceiver) =>
          (sender && transceiver.sender === sender) ||
          transceiver.sender.track === track,
      )?.mid;
    };
    const liveTracks = stream
      .getTracks()
      .filter((track) => track.readyState !== "ended");
    const videoSources = liveTracks
      .filter((track) => track.kind === "video")
      .flatMap((track) => {
        const kind =
          this.options.getVideoSourceKind?.(track);
        if (!kind) return [];
        const mid = midOf(track);
        return mid ? [{ mid, kind }] : [];
      });
    const audioSources = liveTracks
      .filter((track) => track.kind === "audio")
      .flatMap<StreamAudioSource>((track) => {
        const mid = midOf(track);
        const source = this.options.getAudioSource?.(track);
        if (!mid || !source) return [];
        if (source.kind === "microphone")
          return [{ mid, kind: source.kind }];
        const videoMid = midOf(source.videoTrack);
        return videoMid &&
          videoSources.some(
            (video) =>
              video.mid === videoMid &&
              video.kind === "screen",
          )
          ? [{ mid, kind: source.kind, videoMid }]
          : [];
      });
    const signature = JSON.stringify([
      videoSources,
      audioSources,
    ]);
    if (
      this.streamStateNotified &&
      this.sourcesSignature === signature
    )
      return;
    this.streamStateNotified = true;
    this.sourcesSignature = signature;
    this.options.notifyStreamState(
      videoSources,
      audioSources,
    );
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
    if (
      signal.aborted ||
      event.track.readyState === "ended"
    )
      return;
    const receiver = event.receiver;
    if ("jitterBufferTarget" in receiver) {
      (receiver as any).jitterBufferTarget = 0;
    }
    if ("playoutDelayHint" in receiver) {
      (receiver as any).playoutDelayHint = 0;
    }

    const track = event.track;
    // A reused transceiver may announce the same receiver track in a different
    // source stream. Replace associations, never stop its other received tracks.
    this.removeRemoteTrack(track);
    const controller = new AbortController();
    signal.addEventListener(
      "abort",
      () => controller.abort(),
      {
        once: true,
        signal: controller.signal,
      },
    );
    const streams = new Set(event.streams);
    this.remoteTracks.set(track, {
      controller,
      streams,
      transceiver: event.transceiver,
    });
    for (const stream of streams) {
      let observed = this.remoteStreams.get(stream);
      if (!observed) {
        const streamController = new AbortController();
        observed = {
          controller: streamController,
          tracks: new Set(),
        };
        this.remoteStreams.set(stream, observed);
        signal.addEventListener(
          "abort",
          () => streamController.abort(),
          {
            once: true,
            signal: streamController.signal,
          },
        );
        stream.addEventListener(
          "removetrack",
          ({ track: removed }) => {
            // Ignore an old removal dispatched after this track was re-associated.
            if (stream.getTracks().includes(removed))
              return;
            const record = this.remoteTracks.get(removed);
            if (!record?.streams.delete(stream)) return;
            this.releaseRemoteStream(stream, removed);
            if (!record.streams.size)
              this.removeRemoteTrack(removed);
            this.publishRemoteStream();
          },
          { signal: streamController.signal },
        );
      }
      observed.tracks.add(track);
    }
    track.addEventListener(
      "ended",
      () => {
        this.removeRemoteTrack(track);
        this.publishRemoteStream();
      },
      { once: true, signal: controller.signal },
    );
    // Temporary RTP silence is not a removed source. Keep its track identity;
    // publish a fresh view so renderers can observe mute recovery.
    for (const type of ["mute", "unmute"] as const)
      track.addEventListener(
        type,
        () => this.publishRemoteStream(),
        { signal: controller.signal },
      );
    this.publishRemoteStream();
  }

  private releaseRemoteStream(
    stream: MediaStream,
    track: MediaStreamTrack,
  ): void {
    const observed = this.remoteStreams.get(stream);
    if (!observed) return;
    observed.tracks.delete(track);
    if (observed.tracks.size) return;
    observed.controller.abort();
    this.remoteStreams.delete(stream);
  }

  private removeRemoteTrack(track: MediaStreamTrack): void {
    const record = this.remoteTracks.get(track);
    if (!record) return;
    record.controller.abort();
    for (const stream of record.streams)
      this.releaseRemoteStream(stream, track);
    this.remoteTracks.delete(track);
  }

  private publishRemoteStream(): void {
    const entries = [...this.remoteTracks.entries()].filter(
      ([track]) => track.readyState !== "ended",
    );
    const tracks = entries.map(([track]) => track);
    // MediaStream.addTrack/removeTrack called by application code do not emit
    // addtrack/removetrack. New containers notify reactive consumers reliably.
    this.remoteStream = tracks.length
      ? new MediaStream(tracks)
      : null;
    this.options.onRemoteStreamChange(this.remoteStream);
    this.options.onRemoteVideoTracksChange(
      entries.flatMap(([track, record]) =>
        track.kind === "video" && record.transceiver.mid
          ? [
              {
                trackId: track.id,
                mid: record.transceiver.mid,
              },
            ]
          : [],
      ),
    );
    this.options.onRemoteAudioTracksChange?.(
      entries.flatMap(([track, record]) =>
        track.kind === "audio" && record.transceiver.mid
          ? [
              {
                trackId: track.id,
                mid: record.transceiver.mid,
              },
            ]
          : [],
      ),
    );
  }

  bindConnection(
    pc: RTCPeerConnection,
    signal: AbortSignal,
  ): void {
    if (signal.aborted) return;
    if (
      this.senderConnection === pc &&
      this.connectionListeners &&
      !this.connectionListeners.signal.aborted
    )
      return;
    if (
      this.senderConnection &&
      this.senderConnection !== pc
    )
      this.resetConnection();
    else this.connectionListeners?.abort();
    const controller = new AbortController();
    this.connectionListeners = controller;
    signal.addEventListener(
      "abort",
      () => controller.abort(),
      {
        once: true,
        signal: controller.signal,
      },
    );
    pc.addEventListener(
      "track",
      (event) =>
        this.handleRemoteTrack(event, controller.signal),
      { signal: controller.signal },
    );
    pc.addEventListener(
      "signalingstatechange",
      () => {
        if (pc.signalingState !== "stable") return;
        this.notifyLocalStreamState(this.localStream);
        this.publishRemoteStream();
      },
      { signal: controller.signal },
    );
    this.senderConnection = pc;
    if (
      this.localStream
        ?.getTracks()
        .some((track) => track.readyState !== "ended")
    ) {
      this.syncLocalTracks();
      this.notifyLocalStreamState(this.localStream);
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

  private releaseLocalListeners(): void {
    this.localListeners?.abort();
    this.localListeners = null;
    for (const controller of this.localTrackListeners.values())
      controller.abort();
    this.localTrackListeners.clear();
  }

  setStream(stream: MediaStream | null): void {
    const previous = this.localStream;
    if (previous !== stream) {
      this.releaseLocalListeners();
      this.localStream = stream;
      if (stream) {
        const controller = new AbortController();
        this.localListeners = controller;
        for (const type of [
          "addtrack",
          "removetrack",
        ] as const)
          stream.addEventListener(
            type,
            () => this.syncLocalTracks(),
            { signal: controller.signal },
          );
      }
    }
    // Explicit calls reconcile even the same MediaStream object: application
    // mutations of its track list do not dispatch MediaStream track events.
    this.syncLocalTracks();
    this.notifyLocalStreamState(stream);
  }

  private syncLocalTracks(): void {
    const stream = this.localStream;
    const tracks = new Set(
      stream
        ?.getTracks()
        .filter((track) => track.readyState !== "ended") ??
        [],
    );
    for (const [track, controller] of this
      .localTrackListeners) {
      if (tracks.has(track)) continue;
      controller.abort();
      this.localTrackListeners.delete(track);
    }
    for (const track of tracks) {
      if (this.localTrackListeners.has(track)) continue;
      const controller = new AbortController();
      this.localTrackListeners.set(track, controller);
      track.addEventListener(
        "ended",
        () => this.syncLocalTracks(),
        { once: true, signal: controller.signal },
      );
    }
    const pc = this.options.getPeerConnection();
    if (!pc || pc.connectionState === "closed") return;
    if (this.senderConnection !== pc) {
      if (this.senderConnection) this.resetConnection();
      this.senders.clear();
      this.senderConnection = pc;
    }
    let changed = false;
    for (const [track, sender] of this.senders) {
      if (tracks.has(track)) continue;
      pc.removeTrack(sender);
      this.senders.delete(track);
      changed = true;
    }
    if (stream)
      for (const track of tracks) {
        if (this.senders.has(track)) continue;
        this.senders.set(track, pc.addTrack(track, stream));
        changed = true;
      }
    // addTrack/removeTrack request native negotiationneeded. Do not also
    // start offers here: it duplicates the browser's coalescing/state handling.
    if (changed) {
      this.applyPreferredCodecPreferences(pc);
      this.notifyLocalStreamState(stream);
    }
  }

  resetConnection(): void {
    this.streamStateNotified = false;
    this.connectionListeners?.abort();
    this.connectionListeners = null;
    this.senders.clear();
    this.senderConnection = null;
    const tracks = [...this.remoteTracks.keys()];
    for (const track of tracks) {
      this.removeRemoteTrack(track);
      track.stop();
    }
    const hadRemoteStream = this.remoteStream !== null;
    this.remoteStream = null;
    if (hadRemoteStream)
      this.options.onRemoteStreamChange(null);
    this.options.onRemoteVideoTracksChange([]);
    this.options.onRemoteAudioTracksChange?.([]);
  }

  dispose(): void {
    this.resetConnection();
    this.releaseLocalListeners();
    // LocalStreamService owns capture. Closing one peer must never stop the
    // microphone, camera or screen tracks still published to other peers.
    this.localStream = null;
  }
}
