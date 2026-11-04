import type {
  RoomConnection,
  RoomScreenTransport,
  RoomTrackEvent,
} from "@weblink/platform";
import { ROOM_SCREEN_PREFIX } from "./native-screen/signaling";
import type { NativeScreenPublication } from "./native-screen/sender";
import {
  recordingAudioSkew,
  type ScreenReceiverFactory,
} from "./native-screen/receiver";
import {
  CONTROL_CHANNEL,
  POINTER_CHANNEL,
  type RemotePointer,
} from "./remote-control/pointer";
import { readBrowserVideoStats } from "./video-stats";
import {
  ScreenDecodeError,
  ScreenDecodeStallError,
} from "./native-screen/errors";
import { monitorScreenDecode } from "./native-screen/decode-monitor";

const STREAM_PREFIX = "weblink-screen-";
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
type Source = {
  id: string;
  stream: MediaStream;
  channels: RTCDataChannel[];
  pendingReady?: string;
  stopListening?: () => void;
  lifetime: AbortController;
  expiry?: ReturnType<typeof setTimeout>;
  update?: () => void;
  control?: RemotePointer;
  claimed: boolean;
};

/** Correlate authenticated screen offers with RTP tracks on the already-negotiated room PC. */
export class RoomScreens {
  private readonly sources = new Map<string, Source>();
  private readonly publications = new WeakMap<
    NativeScreenPublication,
    NativeScreenPublication
  >();
  constructor(
    private readonly pc: () => RoomConnection | null,
    private readonly accepts: () => boolean,
    private readonly native: boolean,
  ) {}
  private source(id: string) {
    if (!uuid.test(id) || !this.accepts()) return;
    let source = this.sources.get(id);
    if (!source && this.sources.size < 32) {
      source = {
        id,
        stream: new MediaStream(),
        channels: [],
        lifetime: new AbortController(),
        claimed: false,
      };
      this.sources.set(id, source);
      source.expiry = setTimeout(
        () => this.remove(id),
        30000,
      );
    }
    return source;
  }
  track(event: RoomTrackEvent): boolean {
    const names =
      event.roomStreamIds ?? event.streams.map((s) => s.id);
    const name = names.find((s) =>
      s?.startsWith(STREAM_PREFIX),
    );
    if (!name) return false;
    const source = this.source(
      name.slice(STREAM_PREFIX.length),
    );
    if (!source) return true;
    const track = event.track;
    if (source.stream.getTracks().includes(track))
      return true;
    for (const previous of source.stream
      .getTracks()
      .filter((t) => t.kind === track.kind))
      source.stream.removeTrack(previous);
    source.stream.addTrack(track);
    const remove = () => {
      source.stream.removeTrack(track);
      source.update?.();
    };
    track.addEventListener("ended", remove, {
      once: true,
      signal: source.lifetime.signal,
    });
    for (const stream of event.streams)
      stream.addEventListener(
        "removetrack",
        (e) => {
          if (e.track === track) remove();
        },
        { signal: source.lifetime.signal },
      );
    source.update?.();
    return true;
  }
  channel(channel: RTCDataChannel) {
    const protocol = channel.protocol;
    if (
      (protocol !== CONTROL_CHANNEL &&
        protocol !== POINTER_CHANNEL) ||
      !channel.label.startsWith(protocol + "/")
    )
      return false;
    const source = this.source(
      channel.label.slice(protocol.length + 1),
    );
    if (
      !source ||
      source.channels.length >= 2 ||
      (source.claimed && !source.control)
    )
      channel.close();
    else if (source.control)
      source.control.bind(channel, source.id);
    else if (
      source.channels.some((c) => c.protocol === protocol)
    )
      channel.close();
    else {
      source.channels.push(channel);
      if (protocol === CONTROL_CHANNEL) {
        // SCTP can deliver the host's one-time ready message before the
        // authenticated publication offer identifies the control target.
        const early = (event: MessageEvent) => {
          const data = event.data;
          if (
            typeof data !== "string" ||
            data.length > 4096
          )
            return;
          try {
            const msg = JSON.parse(data);
            if (
              msg?.type === "ready" &&
              msg.generation === source.id
            )
              source.pendingReady = data;
          } catch {
            /* Ignore unrelated or malformed messages before binding. */
          }
        };
        channel.addEventListener("message", early, {
          signal: source.lifetime.signal,
        });
        source.stopListening = () =>
          channel.removeEventListener("message", early);
      }
    }
    return true;
  }
  readonly receiver: ScreenReceiverFactory = (
    offer,
    _config,
    changed,
    failed,
    _candidate,
    control,
  ) => {
    if (!offer.startsWith(ROOM_SCREEN_PREFIX))
      throw new Error("Expected a room screen reference");
    const id = offer.slice(ROOM_SCREEN_PREFIX.length);
    const source = this.source(id),
      pc = this.pc();
    if (!source || !pc || source.claimed)
      throw new Error("Unrecognized room screen");
    source.claimed = true;
    clearTimeout(source.expiry);
    source.control = control;
    source.stopListening?.();
    source.stopListening = undefined;
    for (const channel of source.channels.splice(0)) {
      if (
        control &&
        channel.protocol === CONTROL_CHANNEL &&
        source.pendingReady
      )
        control.bind(channel, id, source.pendingReady);
      else if (control) control.bind(channel, id);
      else channel.close();
    }
    source.pendingReady = undefined;
    const active = () => this.sources.get(id) === source;
    const monitorOptions = this.native
      ? { maxProcessingDelayMs: 250 }
      : {};
    let wake: (() => void) | undefined;
    let monitor: (() => void) | undefined;
    source.update = () => {
      if (!active()) return;
      changed(
        source.stream.getTracks().length
          ? new MediaStream(source.stream.getTracks())
          : null,
      );
      wake?.();
    };
    control?.addEventListener(
      "transporterror",
      () => {
        if (active())
          failed(new Error("Room screen control closed"));
      },
      { signal: source.lifetime.signal },
    );
    return {
      get stream() {
        return source.stream;
      },
      answer: async () => {
        source.update?.();
        return offer;
      },
      addIceCandidate: async () => {
        throw new Error(
          "ICE belongs to the room connection",
        );
      },
      connected: () =>
        new Promise<void>((resolve, reject) => {
          const signal = source.lifetime.signal;
          const finish = (error?: Error) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            wake = undefined;
            error ? reject(error) : resolve();
          };
          const abort = () =>
            finish(new Error("Room screen stopped"));
          const timer = setTimeout(
            () =>
              finish(
                new Error("Room screen track timed out"),
              ),
            20000,
          );
          wake = () => {
            if (!active()) abort();
            else if (source.stream.getVideoTracks().length)
              finish();
          };
          signal.addEventListener("abort", abort, {
            once: true,
          });
          wake();
        }),
      monitorDecode(healthy) {
        const track = source.stream.getVideoTracks()[0];
        const receiver = pc
          .getReceivers()
          .find((r) => r.track === track);
        if (!receiver) return;
        monitor?.();
        monitor = monitorScreenDecode(
          {
            getStats: () => receiver.getStats(),
            get connectionState() {
              return pc.connectionState;
            },
            addEventListener: pc.addEventListener.bind(pc),
            removeEventListener:
              pc.removeEventListener.bind(pc),
          },
          healthy,
          () => failed(new ScreenDecodeStallError()),
          monitorOptions,
        );
      },
      decodeFailed() {
        if (active()) failed(new ScreenDecodeError());
      },
      recordingAudioSkew: () =>
        recordingAudioSkew(pc, source.stream.getTracks()),
      getVideoStats: (t) =>
        readBrowserVideoStats(pc, t, "receive"),
      close: () => {
        monitor?.();
        if (active()) {
          this.remove(id);
          changed(null);
        }
      },
    };
  };
  publication(
    pub: NativeScreenPublication,
    connection: () => RoomScreenTransport | null,
  ): NativeScreenPublication {
    const cached = this.publications.get(pub);
    if (cached) return cached;
    const leases = new Map<string, RoomScreenTransport>();
    const wrapped: NativeScreenPublication = {
      ...pub,
      addIceCandidate: undefined,
      async offer(
        id,
        _servers,
        _relay,
        _candidate,
        control,
        codecs,
      ) {
        const pc = connection();
        if (!pc || !pub.captureId || !codecs)
          throw new Error(
            "Room screen transport unavailable",
          );
        leases.set(id, pc);
        try {
          await pc.attachScreen(
            pub.captureId,
            id,
            codecs,
            control,
          );
        } catch (error) {
          leases.delete(id);
          throw error;
        }
        return ROOM_SCREEN_PREFIX + id;
      },
      async answer(id, answer) {
        if (answer !== ROOM_SCREEN_PREFIX + id)
          throw new Error(
            "Room screen acknowledgement mismatch",
          );
        await leases.get(id)?.screenReady(id);
      },
      async closePeer(id) {
        const pc = leases.get(id);
        leases.delete(id);
        await pc?.detachScreen(id);
      },
    };
    this.publications.set(pub, wrapped);
    return wrapped;
  }
  private remove(id: string) {
    const source = this.sources.get(id);
    if (!source) return;
    this.sources.delete(id);
    clearTimeout(source.expiry);
    source.lifetime.abort();
    source.control?.close();
    source.channels.forEach((c) => c.close());
  }
  reset() {
    for (const id of this.sources.keys()) this.remove(id);
  }
}
