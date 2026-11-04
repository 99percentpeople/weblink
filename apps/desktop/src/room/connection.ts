import { Channel, invoke } from "@tauri-apps/api/core";
import type {
  NativeControlContext,
  NativeSendCodecs,
  RoomTransport,
  RoomConfiguration,
  RoomConnection,
  RoomDescription,
  RoomChannelOptions,
  RoomScreenTransport,
  RoomTrackEvent,
  RoomTransceiver,
  RoomSender,
} from "@weblink/platform";
import type { NativePresentation } from "../presentation";
import { RoomCaptures } from "./capture";
import { RoomDataChannel } from "./channel";
import { roomOutput, type RoomOutput } from "./output";

type NativeEvent =
  | { type: "candidate"; candidate: RTCIceCandidateInit }
  | { type: "state"; state: RTCPeerConnectionState }
  | { type: "ice"; state: RTCIceConnectionState }
  | { type: "negotiation" }
  | {
      type: "channel";
      key: number;
      label: string;
      protocol: string;
      ordered: boolean;
      maxRetransmits: number;
      maxPacketLifeTime: number;
    }
  | {
      type: "channel-state";
      key: number;
      state: RTCDataChannelState;
      id: number;
    }
  | { type: "drain"; key: number; bytes: number }
  | {
      type: "track";
      key: number;
      mid: string;
      kind: "video" | "audio";
      streams: string[];
    }
  | {
      type: "media";
      key: number;
      event: { type: string; error?: string };
    }
  | { type: "untrack"; key: number };
interface NativeTransceiver extends RoomTransceiver {
  mid: string | null;
  sender: RoomSender & { track: MediaStreamTrack | null };
}
function configuration(config: RoomConfiguration) {
  return {
    servers: (config.iceServers ?? []).map((s) => ({
      ...s,
      urls: typeof s.urls === "string" ? [s.urls] : s.urls,
      username: s.username ?? "",
      credential: s.credential ?? "",
    })),
    relay: config.iceTransportPolicy === "relay",
  };
}
const optional = (n: number) => (n < 0 ? undefined : n);
type Operation = { type: string; [key: string]: unknown };

/** Signaling, SCTP and media negotiate on the same native handle for the peer's lifetime. */
class NativeConnection
  extends EventTarget
  implements RoomConnection, RoomScreenTransport
{
  // EventTarget delivers the translated room events and the adapter's private "retired" event.
  declare addEventListener: RoomConnection["addEventListener"] &
    EventTarget["addEventListener"];
  declare removeEventListener: RoomConnection["removeEventListener"] &
    EventTarget["removeEventListener"];
  get screenTransport(): RoomScreenTransport {
    return this;
  }
  readonly id = crypto.randomUUID();
  connectionState: RTCPeerConnectionState = "new";
  iceConnectionState: RTCIceConnectionState = "new";
  signalingState: RTCSignalingState = "stable";
  localDescription: RTCSessionDescription | null = null;
  private currentLocalDescription: RTCSessionDescription | null =
    null;
  remoteDescription: RTCSessionDescription | null = null;
  currentRemoteDescription: RTCSessionDescription | null =
    null;
  readonly sctp = { maxMessageSize: 65536 };
  private readonly channels = new Map<
    number,
    RoomDataChannel
  >();
  private readonly incoming = new Map<
    number,
    {
      output: RoomOutput;
      t: NativeTransceiver;
      published: boolean;
    }
  >();
  private readonly outgoing = new Map<
    MediaStreamTrack,
    {
      t: NativeTransceiver;
      lease:
        | ReturnType<RoomCaptures["acquire"]>
        | undefined;
    }
  >();
  private nextChannel = 1;
  private readonly open: Promise<void>;
  private closing?: Promise<void>;
  private tail: Promise<unknown>;
  private closed = false;
  private ack = 0;
  private ackTimer?: ReturnType<typeof setTimeout>;
  constructor(
    private config: RoomConfiguration,
    private readonly captures: RoomCaptures,
    private readonly presentation: NativePresentation,
    remoteId: string,
    previous: Promise<void>,
  ) {
    super();
    const bridge = new Channel<NativeEvent | ArrayBuffer>(
      (e) => this.event(e),
    );
    const { servers, relay } = configuration(config);
    this.open = previous.then(() => {
      if (this.closed)
        throw new DOMException("Room closed", "AbortError");
      return invoke<void>("room_open", {
        id: this.id,
        remoteId,
        iceServers: servers,
        relay,
        events: bridge,
      });
    });
    this.tail = this.open.catch((e) => this.fail(e));
  }
  private call<T>(operation: Operation): Promise<T> {
    return invoke<T>("room_operation", {
      id: this.id,
      operation,
    });
  }
  private ordered<T>(fn: () => Promise<T>) {
    const call = this.tail.then(async () => {
      await this.open;
      if (this.closed)
        throw new DOMException("Room closed", "AbortError");
      return fn();
    });
    this.tail = call.catch(() => {});
    return call;
  }
  private report(error: unknown) {
    if (!this.closed)
      this.dispatchEvent(
        new ErrorEvent("error", {
          error,
          message: String(error),
        }),
      );
  }
  private change(
    operation: Operation,
    onError: (error: unknown) => void = (e) =>
      this.report(e),
  ) {
    void this.ordered(() => this.call(operation)).catch(
      onError,
    );
  }
  private fail(error: unknown) {
    if (this.closed || this.connectionState === "failed")
      return;
    console.error("Native room transport", error);
    this.connectionState = "failed";
    this.dispatchEvent(new Event("connectionstatechange"));
  }
  private event(event: NativeEvent | ArrayBuffer) {
    if (this.closed) return;
    if (event instanceof ArrayBuffer) {
      if (event.byteLength < 5) return;
      this.ack += event.byteLength;
      this.ackTimer ??= setTimeout(() => {
        this.ackTimer = undefined;
        const bytes = this.ack;
        this.ack = 0;
        if (!this.closed)
          void this.call({ type: "ack", bytes }).catch(
            (e) => this.fail(e),
          );
      }, 0);
      const view = new DataView(event);
      this.channels
        .get(view.getUint32(0, true))
        ?.receive(
          new Uint8Array(event, 5),
          view.getUint8(4) === 1,
        );
      return;
    }
    switch (event.type) {
      case "state":
        this.connectionState = event.state;
        this.dispatchEvent(
          new Event("connectionstatechange"),
        );
        break;
      case "ice":
        this.iceConnectionState = event.state;
        this.dispatchEvent(
          new Event("iceconnectionstatechange"),
        );
        break;
      case "candidate":
        this.dispatchEvent(
          Object.assign(new Event("icecandidate"), {
            candidate: new RTCIceCandidate(event.candidate),
          }),
        );
        break;
      case "negotiation":
        this.dispatchEvent(new Event("negotiationneeded"));
        break;
      case "channel": {
        const channel = this.channel(
          event.key,
          event.label,
          {
            ordered: event.ordered,
            protocol: event.protocol,
            maxPacketLifeTime: optional(
              event.maxPacketLifeTime,
            ),
            maxRetransmits: optional(event.maxRetransmits),
          },
        );
        this.dispatchEvent(
          Object.assign(new Event("datachannel"), {
            channel,
          }),
        );
        break;
      }
      case "channel-state":
        this.channels
          .get(event.key)
          ?.state(event.state, event.id);
        if (event.state === "closed")
          this.channels.delete(event.key);
        break;
      case "drain":
        this.channels.get(event.key)?.drain(event.bytes);
        break;
      case "track":
        this.addOutput(event);
        break;
      case "media": {
        const source = this.incoming.get(event.key);
        if (event.event.type === "audio")
          source?.output.audio();
        if (event.event.type === "error")
          this.removeOutput(event.key);
        break;
      }
      case "untrack":
        this.removeOutput(event.key);
        break;
    }
  }
  private channel(
    key: number,
    label: string,
    options: RTCDataChannelInit,
  ) {
    const channel = new RoomDataChannel(
      this.id,
      key,
      label,
      options,
      () => this.change({ type: "close-channel", key }),
    );
    this.channels.set(key, channel);
    return channel;
  }
  createDataChannel(
    label: string,
    options: RoomChannelOptions = {},
  ) {
    const key = this.nextChannel++,
      channel = this.channel(key, label, options);
    this.change(
      {
        type: "channel",
        key,
        options: {
          label,
          protocol: options.protocol ?? "",
          ordered: options.ordered ?? true,
          maxRetransmits: options.maxRetransmits,
          maxPacketLifeTime: options.maxPacketLifeTime,
        },
      },
      (error) => {
        this.channels.delete(key);
        channel.dispatchEvent(new Event("error"));
        channel.state("closed");
        this.report(error);
      },
    );
    return channel;
  }
  private addOutput(
    event: Extract<NativeEvent, { type: "track" }>,
  ) {
    const changed = () => {
      const entry = this.incoming.get(event.key);
      if (
        !entry ||
        entry.published ||
        !entry.output.track ||
        !entry.output.stream
          .getTracks()
          .includes(entry.output.track)
      )
        return;
      entry.published = true;
      const received: RoomTrackEvent = Object.assign(
        new Event("track"),
        {
          track: entry.output.track,
          streams: [entry.output.stream],
          roomStreamIds: event.streams,
          transceiver: entry.t,
          receiver: entry.t.receiver,
        },
      );
      this.dispatchEvent(received);
    };
    const output = roomOutput(
      this.id,
      event.key,
      event.mid,
      event.kind,
      this.presentation,
      changed,
      () => this.removeOutput(event.key),
    );
    const t = this.transceiver(null, output.track ?? null);
    t.mid = event.mid;
    this.incoming.set(event.key, {
      output,
      t,
      published: false,
    });
    void output.ready.then(changed, () =>
      this.removeOutput(event.key),
    );
  }
  private removeOutput(key: number) {
    const entry = this.incoming.get(key);
    if (!entry) return;
    this.incoming.delete(key);
    entry.output.close();
    entry.output.track?.dispatchEvent(new Event("ended"));
  }
  private transceiver(
    local: MediaStreamTrack | null,
    remote: MediaStreamTrack | null,
  ): NativeTransceiver {
    let parameters: RTCRtpSendParameters = {
      transactionId: crypto.randomUUID(),
      encodings: [{}],
      codecs: [],
      headerExtensions: [],
      rtcp: {},
    };
    const t: NativeTransceiver = {
      mid: null,
      sender: {
        track: local,
        getStats: () =>
          this.trackStats(t.mid, "outbound-rtp"),
        getParameters: () => structuredClone(parameters),
        setParameters: async (p) => {
          if (!local) return;
          const e = p.encodings[0];
          await this.ordered(() =>
            this.call({
              type: "limits",
              track: local.id,
              bitrate: e?.maxBitrate,
              fps: e?.maxFramerate,
              scale: e?.scaleResolutionDownBy,
              degradation: p.degradationPreference,
            }),
          );
          parameters = structuredClone(p);
        },
      },
      receiver: {
        track: remote,
        getStats: () =>
          this.trackStats(t.mid, "inbound-rtp"),
      },
      setCodecPreferences: (codecs) => {
        if (local)
          this.change({
            type: "codecs",
            track: local.id,
            codecs: [
              ...new Set(
                codecs.map((c) => c.mimeType.toLowerCase()),
              ),
            ],
          });
      },
    };
    return t;
  }
  addTrack(
    track: MediaStreamTrack,
    ...streams: MediaStream[]
  ) {
    if (this.outgoing.has(track))
      throw new Error("Duplicate room track");
    const entry = {
      t: this.transceiver(track, null),
      lease: undefined as
        | ReturnType<RoomCaptures["acquire"]>
        | undefined,
    };
    this.outgoing.set(track, entry);
    const failed = (error: unknown) => {
      if (this.outgoing.get(track) !== entry) return;
      this.removeTrack(entry.t.sender);
      this.report(error);
    };
    void this.ordered(async () => {
      if (this.outgoing.get(track) !== entry) return;
      entry.lease = this.captures.acquire(
        this.id,
        track,
        failed,
      );
      await entry.lease.ready;
      if (this.outgoing.get(track) === entry)
        await this.call({
          type: "add",
          track: track.id,
          source: entry.lease.id,
          streams: [
            ...new Set(streams.map((stream) => stream.id)),
          ],
        });
    }).catch(failed);
    return entry.t.sender;
  }
  removeTrack(sender: NativeTransceiver["sender"]) {
    const track = sender.track,
      entry = track && this.outgoing.get(track);
    if (!track || !entry || entry.t.sender !== sender)
      return;
    this.outgoing.delete(track);
    sender.track = null;
    entry.lease?.release();
    this.change({ type: "remove", track: track.id });
  }
  getSenders() {
    return [...this.outgoing.values()].map(
      (e) => e.t.sender,
    );
  }
  getReceivers() {
    return [...this.incoming.values()].map(
      (e) => e.t.receiver,
    );
  }
  getTransceivers() {
    return [
      ...this.outgoing.values(),
      ...this.incoming.values(),
    ].map((e) => e.t);
  }
  private mids(mids: Record<string, string>) {
    for (const [track, e] of this.outgoing)
      e.t.mid = mids[track.id] ?? null;
  }
  getConfiguration() {
    return this.config;
  }
  setConfiguration(config: RoomConfiguration) {
    this.config = config;
    this.change({
      type: "configure",
      ...configuration(config),
    });
  }
  async setLocalDescription() {
    await this.ordered(async () => {
      const { description, mids } = await this.call<{
        description: RTCSessionDescriptionInit;
        mids: Record<string, string>;
      }>({ type: "local" });
      this.localDescription = new RTCSessionDescription(
        description,
      );
      this.mids(mids);
      this.signalingState =
        description.type === "answer"
          ? "stable"
          : "have-local-offer";
      if (this.signalingState === "stable") {
        this.currentLocalDescription =
          this.localDescription;
        this.currentRemoteDescription =
          this.remoteDescription;
      }
      this.dispatchEvent(new Event("signalingstatechange"));
    });
  }
  async setRemoteDescription(description: RoomDescription) {
    await this.ordered(async () => {
      const mids = await this.call<Record<string, string>>({
        type: "remote",
        kind: description.type,
        sdp: description.sdp,
      });
      this.mids(mids);
      if (
        description.type === "offer" &&
        this.signalingState === "have-local-offer"
      )
        this.localDescription =
          this.currentLocalDescription;
      this.remoteDescription = new RTCSessionDescription(
        description,
      );
      this.signalingState =
        description.type === "answer"
          ? "stable"
          : "have-remote-offer";
      if (this.signalingState === "stable") {
        this.currentLocalDescription =
          this.localDescription;
        this.currentRemoteDescription =
          this.remoteDescription;
      }
      const maxMessageSize = description.sdp?.match(
        /^a=max-message-size:(\d+)\s*$/m,
      )?.[1];
      this.sctp.maxMessageSize = Math.min(
        65536,
        Number(maxMessageSize) || 65536,
      );
      this.dispatchEvent(new Event("signalingstatechange"));
    });
  }
  addIceCandidate(candidate: RTCIceCandidateInit) {
    return this.ordered(() =>
      this.call<void>({ type: "candidate", candidate }),
    );
  }
  async getStats(): Promise<RTCStatsReport> {
    const reports = await this.call<
      (RTCStats & Record<string, unknown>)[]
    >({ type: "stats" });
    return new Map(reports.map((s) => [s.id, s]));
  }
  private async trackStats(
    mid: string | null,
    type: string,
  ): Promise<RTCStatsReport> {
    const stats = new Map(await this.getStats());
    for (const [id, report] of stats) {
      if (report.type === type && report.mid !== mid)
        stats.delete(id);
      else if (
        report.type === "inbound-rtp" &&
        report.mid === mid &&
        type === "inbound-rtp"
      ) {
        const entry = [...this.incoming.values()].find(
          (e) => e.t.mid === mid,
        );
        if (entry?.output.track?.kind === "video")
          report.nativeReceive = await entry.output.stats();
      }
    }
    return stats;
  }
  private allowed?: boolean;
  receiveContent(allowed: boolean) {
    if (this.allowed === allowed) return;
    this.allowed = allowed;
    this.change({ type: "receive", allowed }, (e) => {
      this.fail(e);
      void this.close();
    });
  }
  attachScreen(
    sessionId: string,
    track: string,
    codecs: NativeSendCodecs,
    control?: NativeControlContext,
  ) {
    return this.ordered(() =>
      invoke<boolean>("room_screen", {
        id: this.id,
        sessionId,
        track,
        codecs,
        control,
      }),
    );
  }
  detachScreen(track: string) {
    return this.ordered(() =>
      this.call<void>({ type: "detach-screen", track }),
    );
  }
  screenReady(track: string) {
    return this.ordered(() =>
      this.call<void>({ type: "screen-ready", track }),
    );
  }
  close() {
    if (this.closing) return this.closing;
    this.closed = true;
    this.signalingState = "closed";
    this.connectionState = "closed";
    clearTimeout(this.ackTimer);
    for (const c of this.channels.values())
      c.state("closed");
    this.channels.clear();
    for (const e of this.outgoing.values())
      e.lease?.release();
    this.outgoing.clear();
    for (const key of this.incoming.keys())
      this.removeOutput(key);
    return (this.closing = this.open
      .then(() => this.call<void>({ type: "close" }))
      .catch(() => {})
      .finally(() =>
        this.dispatchEvent(new Event("retired")),
      ));
  }
}

export function createRoomTransport(
  presentation: NativePresentation,
): RoomTransport {
  const captures = new RoomCaptures();
  const rooms = new Map<string, NativeConnection>();
  return {
    kind: "native",
    create: (config, remoteId) => {
      const previous =
        rooms.get(remoteId)?.close() ?? Promise.resolve();
      const room = new NativeConnection(
        config,
        captures,
        presentation,
        remoteId,
        previous,
      );
      rooms.set(remoteId, room);
      room.addEventListener(
        "retired",
        () => {
          if (rooms.get(remoteId) === room)
            rooms.delete(remoteId);
        },
        { once: true },
      );
      return room;
    },
  };
}
