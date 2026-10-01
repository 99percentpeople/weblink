import { createUuid } from "../ids";
import {
  ScreenControlRequest,
  type ScreenControlSignal,
} from "./control-request";
import { RemotePointer } from "../remote-control/pointer";
import type { NativeControlContext } from "@weblink/platform";
import { ScreenReceiver } from "./receiver";
import { bindNativeScreenAudio } from "./tracks";
import {
  parseControlCapabilities,
  type ControlCapabilities,
} from "../protocol/remote-control";
import type { NativeVideoSettings } from "@weblink/platform";
import {
  readBrowserVideoStats,
  type VideoStatsBatch,
  type VideoStatsSample,
} from "../video-stats";

export const NATIVE_SCREEN_CHANNEL =
  "weblink-desktop-media";
export interface NativeScreenPublication {
  readonly sourceId: string;
  readonly controlEligible?: boolean;
  getSenderStats?(
    peerId?: string,
  ): Promise<VideoStatsSample[]>;
  getPreviewStats?(): Promise<VideoStatsBatch[]>;
  updateVideoSettings?(
    settings: NativeVideoSettings,
  ): Promise<void>;
  setAudioEnabled?(enabled: boolean): Promise<void>;
  offer(
    peerId: string,
    servers: RTCIceServer[],
    relay: boolean,
    onCandidate?: (candidate: RTCIceCandidateInit) => void,
    control?: NativeControlContext,
  ): Promise<string>;
  answer(peerId: string, sdp: string): Promise<void>;
  addIceCandidate?(
    peerId: string,
    candidate: RTCIceCandidateInit,
  ): Promise<void>;
  closePeer(peerId: string): Promise<void>;
}
interface ScreenSessionPort {
  requestScreen?(
    signal: AbortSignal,
  ): Promise<string | undefined>;
  cancelScreenRequest?(): void;
  /** Omitted until the corresponding control implementation is ready. */
  controlCapabilities?: ControlCapabilities;
  loadControlCapabilities?(): Promise<ControlCapabilities>;
  controlContext?(): Promise<
    Omit<NativeControlContext, "sourceId"> | undefined
  >;
  loadIceServers(): Promise<RTCIceServer[]>;
  relayOnly(): boolean;
  changed(stream: MediaStream | null): void;
  error(error: unknown): void;
}
type Signal =
  | ScreenControlSignal
  | {
      type: "hello";
      receiveScreen: true;
      trickleIce?: true;
      multiScreen?: true;
      remoteControl?: ControlCapabilities;
      requestScreen?: true;
    }
  | {
      type: "offer";
      id: string;
      sourceId: string;
      control?: true;
      sdp: string;
      trickleIce?: true;
    }
  | { type: "answer"; id: string; sdp: string }
  | {
      type: "candidate";
      id: string;
      candidate: RTCIceCandidateInit;
    }
  | { type: "stop"; id: string }
  | { type: "retry"; id: string };
export function parseScreenSignal(
  data: unknown,
): Signal | undefined {
  if (typeof data !== "string" || data.length > 65536)
    return;
  try {
    const value = JSON.parse(data);
    if (!value || typeof value !== "object") return;
    if (
      value.type === "hello" &&
      value.receiveScreen === true
    )
      return value;
    if (
      typeof value.id !== "string" ||
      !value.id.length ||
      value.id.length > 128
    )
      return;
    if (value.type === "stop" || value.type === "retry")
      return value;
    if (
      value.type === "control-request" ||
      value.type === "control-cancel"
    )
      return value;
    if (value.type === "control-result") {
      if (
        value.sourceId === undefined ||
        (typeof value.sourceId === "string" &&
          value.sourceId.length > 0 &&
          value.sourceId.length <= 128)
      )
        return value;
      return;
    }
    if (value.type === "candidate") {
      const candidate = value.candidate;
      if (
        candidate &&
        typeof candidate.candidate === "string" &&
        candidate.candidate.length > 0 &&
        candidate.candidate.length <= 4096 &&
        (candidate.sdpMid == null ||
          (typeof candidate.sdpMid === "string" &&
            candidate.sdpMid.length <= 128)) &&
        (candidate.sdpMLineIndex == null ||
          (Number.isInteger(candidate.sdpMLineIndex) &&
            candidate.sdpMLineIndex >= 0 &&
            candidate.sdpMLineIndex <= 65535)) &&
        (candidate.sdpMid != null ||
          candidate.sdpMLineIndex != null)
      )
        return value;
      return;
    }
    if (
      typeof value.sdp !== "string" ||
      value.sdp.length > 60000
    )
      return;
    if (value.type === "answer") return value;
    if (
      value.type === "offer" &&
      typeof value.sourceId === "string" &&
      value.sourceId.length > 0 &&
      value.sourceId.length <= 128
    )
      return value;
  } catch {
    /* Ignore malformed or future control messages. */
  }
}

const MAX_SCREENS = 16;
type Outgoing = {
  id: string;
  answerApplied: boolean;
  candidates: RTCIceCandidateInit[];
};
type Publication = {
  publication: NativeScreenPublication;
  outgoing?: Outgoing;
  retries: number;
  timer?: ReturnType<typeof setTimeout>;
};
type Incoming = {
  id: string;
  sourceId: string;
  receiver?: ScreenReceiver;
  control?: RemotePointer;
  stream?: MediaStream;
  candidates: RTCIceCandidateInit[];
};

/** Authenticated control channel; each source owns its media connection and retries.
 * Multiple sources require an additive hello capability. Legacy peers keep one. */
export class NativeScreenSession {
  readonly screenControl = new ScreenControlRequest(
    (value) => this.send(value),
  );
  private screenRequest?: {
    id: string;
    abort: AbortController;
  };
  private localCapabilities?: ControlCapabilities;
  private channel?: RTCDataChannel;
  private listeners?: AbortController;
  private ready = false;
  private trickleIce = false;
  private multiScreen = false;
  private controlCapabilities?: ControlCapabilities;
  get remoteControlCapabilities():
    | ControlCapabilities
    | undefined {
    return (
      this.controlCapabilities && {
        ...this.controlCapabilities,
      }
    );
  }
  private publications = new Map<string, Publication>();
  private incoming = new Map<string, Incoming>();
  constructor(private readonly port: ScreenSessionPort) {}

  getRemoteControl(
    track: MediaStreamTrack,
  ): RemotePointer | undefined {
    return [...this.incoming.values()].find((entry) =>
      entry.receiver?.stream
        .getVideoTracks()
        .includes(track),
    )?.control;
  }
  async getVideoStats(
    track: MediaStreamTrack,
    publication?: NativeScreenPublication,
  ): Promise<VideoStatsBatch[]> {
    for (const { receiver } of this.incoming.values()) {
      if (receiver?.stream.getVideoTracks().includes(track))
        return [
          {
            key: receiver.pc,
            direction: "receive",
            samples: await readBrowserVideoStats(
              receiver.pc,
              track,
              "receive",
            ),
          },
        ];
    }
    const entry =
      publication &&
      this.publications.get(publication.sourceId);
    if (
      entry?.outgoing &&
      entry.publication === publication &&
      publication.getSenderStats
    )
      return [
        {
          key: entry.outgoing,
          direction: "send",
          samples: await publication.getSenderStats(
            entry.outgoing.id,
          ),
        },
      ];
    return [];
  }

  bind(channel: RTCDataChannel): void {
    if (channel === this.channel) return;
    this.reset();
    this.channel = channel;
    const listeners = (this.listeners =
      new AbortController());
    const hello = (capabilities?: ControlCapabilities) => {
      if (
        this.channel !== channel ||
        listeners.signal.aborted
      )
        return;
      this.localCapabilities = capabilities;
      this.send({
        type: "hello",
        receiveScreen: true,
        trickleIce: true,
        multiScreen: true,
        ...(capabilities?.host && this.port.requestScreen
          ? { requestScreen: true as const }
          : {}),
        ...(capabilities
          ? {
              remoteControl: {
                ...capabilities,
              },
            }
          : {}),
      });
    };
    const open = () => {
      if (this.port.loadControlCapabilities)
        void this.port
          .loadControlCapabilities()
          .then(hello)
          .catch((error) => {
            this.port.error(error);
            hello();
          });
      else hello(this.port.controlCapabilities);
    };
    channel.addEventListener("open", open, {
      signal: listeners.signal,
    });
    channel.addEventListener("close", () => this.reset(), {
      signal: listeners.signal,
    });
    channel.addEventListener(
      "message",
      (event) => {
        const value = parseScreenSignal(event.data);
        if (value)
          void this.handle(value).catch((error) =>
            this.port.error(error),
          );
      },
      { signal: listeners.signal },
    );
    if (channel.readyState === "open") open();
  }

  async refreshControlCapabilities() {
    const channel = this.channel;
    const capabilities =
      await this.port.loadControlCapabilities?.();
    if (
      !channel ||
      channel !== this.channel ||
      channel.readyState !== "open"
    )
      return;
    const changed =
      this.localCapabilities?.host !== capabilities?.host;
    this.localCapabilities = capabilities;
    this.send({
      type: "hello",
      receiveScreen: true,
      trickleIce: true,
      multiScreen: true,
      remoteControl: capabilities,
      ...(capabilities?.host && this.port.requestScreen
        ? { requestScreen: true as const }
        : {}),
    });
    if (changed) {
      for (const entry of this.publications.values()) {
        this.stopOutgoing(entry);
        entry.retries = 0;
      }
      this.publishSelected();
    }
  }

  setPublication(publication?: NativeScreenPublication) {
    this.setPublications(publication ? [publication] : []);
  }
  setPublications(
    publications: readonly NativeScreenPublication[],
  ) {
    const next = new Map(
      publications.map((p) => [p.sourceId, p]),
    );
    if (next.size > MAX_SCREENS)
      throw new Error(
        "Native screen publication limit reached",
      );
    for (const [sourceId, entry] of this.publications) {
      if (next.get(sourceId) !== entry.publication) {
        this.stopOutgoing(entry);
        this.publications.delete(sourceId);
      }
    }
    for (const [sourceId, publication] of next) {
      if (!this.publications.has(sourceId))
        this.publications.set(sourceId, {
          publication,
          retries: 0,
        });
    }
    this.publishSelected();
  }
  reset(): void {
    this.screenRequest?.abort.abort();
    this.screenRequest = undefined;
    this.port.cancelScreenRequest?.();
    this.screenControl.setAvailable(false);
    this.localCapabilities = undefined;
    this.listeners?.abort();
    this.listeners = undefined;
    const channel = this.channel;
    this.channel = undefined;
    this.ready = false;
    this.trickleIce = false;
    this.multiScreen = false;
    this.controlCapabilities = undefined;
    for (const entry of this.publications.values()) {
      this.stopOutgoing(entry);
      entry.retries = 0;
    }
    this.stopIncoming();
    channel?.close();
  }
  private send(value: Signal): void {
    if (this.channel?.readyState !== "open") return;
    const data = JSON.stringify(value);
    if (
      data.length > 65536 ||
      this.channel.bufferedAmount > 262144
    )
      throw new Error("Native screen signaling overflow");
    this.channel.send(data);
  }
  private changed() {
    const streams = [...this.incoming.values()].flatMap(
      (entry) => (entry.stream ? [entry.stream] : []),
    );
    this.port.changed(
      streams.length > 1
        ? new MediaStream(
            streams.flatMap((stream) => stream.getTracks()),
          )
        : (streams[0] ?? null),
    );
  }
  private stopIncoming(id?: string) {
    const entries = id
      ? [this.incoming.get(id)].filter(
          (entry): entry is Incoming => !!entry,
        )
      : [...this.incoming.values()];
    for (const incoming of entries) {
      this.incoming.delete(incoming.id);
      incoming.control?.close();
      incoming.receiver?.close();
    }
    this.changed();
  }
  private stopOutgoing(entry: Publication) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
    const outgoing = entry.outgoing;
    entry.outgoing = undefined;
    if (!outgoing) return;
    try {
      this.send({ type: "stop", id: outgoing.id });
    } catch (error) {
      this.port.error(error);
    } finally {
      // Tell the receiver this is intentional before closing its input channels.
      // Native resources must still close if signaling has overflowed.
      void entry.publication
        .closePeer(outgoing.id)
        .catch(() => {});
    }
  }
  private selected(entry: Publication) {
    return (
      this.publications.get(entry.publication.sourceId) ===
        entry &&
      (this.multiScreen ||
        this.publications.values().next().value === entry)
    );
  }
  private current(entry: Publication, outgoing: Outgoing) {
    return (
      this.selected(entry) && entry.outgoing === outgoing
    );
  }
  private publishSelected() {
    for (const entry of this.publications.values()) {
      if (this.selected(entry)) void this.publish(entry);
      else this.stopOutgoing(entry);
    }
  }
  private async publish(entry: Publication) {
    if (
      !this.ready ||
      !this.selected(entry) ||
      entry.outgoing ||
      entry.timer ||
      entry.retries > 3
    )
      return;
    const outgoing: Outgoing = {
      id: createUuid(),
      answerApplied: false,
      candidates: [],
    };
    entry.outgoing = outgoing;
    try {
      const servers = await this.port.loadIceServers();
      if (!this.current(entry, outgoing)) return;
      const trickle =
        this.trickleIce &&
        !!entry.publication.addIceCandidate;
      let offered = false;
      const pending: RTCIceCandidateInit[] = [];
      const onCandidate = (
        candidate: RTCIceCandidateInit,
      ) => {
        if (!this.current(entry, outgoing)) return;
        if (!offered) {
          if (pending.length < 256) pending.push(candidate);
        } else
          this.send({
            type: "candidate",
            id: outgoing.id,
            candidate,
          });
      };
      const args = [
        outgoing.id,
        servers,
        this.port.relayOnly(),
      ] as const;
      const context =
        this.controlCapabilities?.request &&
        entry.publication.controlEligible
          ? await this.port.controlContext?.()
          : undefined;
      if (!this.current(entry, outgoing)) return;
      const control = context
        ? {
            ...context,
            sourceId: entry.publication.sourceId,
          }
        : undefined;
      const sdp = control
        ? await entry.publication.offer(
            ...args,
            trickle ? onCandidate : undefined,
            control,
          )
        : trickle
          ? await entry.publication.offer(
              ...args,
              onCandidate,
            )
          : await entry.publication.offer(...args);
      if (!this.current(entry, outgoing)) {
        await entry.publication
          .closePeer(outgoing.id)
          .catch(() => {});
        return;
      }
      this.send({
        type: "offer",
        id: outgoing.id,
        sourceId: entry.publication.sourceId,
        ...(control ? { control: true as const } : {}),
        sdp,
        ...(trickle ? { trickleIce: true as const } : {}),
      });
      offered = true;
      pending.forEach(onCandidate);
      entry.timer = setTimeout(
        () => this.retry(entry, outgoing.id),
        30000,
      );
    } catch (error) {
      if (this.current(entry, outgoing)) {
        this.port.error(error);
        this.retry(entry, outgoing.id);
      }
    }
  }
  private retry(entry: Publication, id: string) {
    if (entry.outgoing?.id !== id) return;
    this.stopOutgoing(entry);
    if (++entry.retries > 3) {
      this.port.error(
        new Error(
          "Native screen could not connect; restart sharing to retry",
        ),
      );
      return;
    }
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.publish(entry);
    }, 1000 * entry.retries);
  }
  private findOutgoing(id: string) {
    return [...this.publications.values()].find(
      (entry) => entry.outgoing?.id === id,
    );
  }
  private async handle(value: Signal) {
    if (value.type === "hello") {
      this.controlCapabilities = parseControlCapabilities(
        value.remoteControl,
      );
      if (!this.controlCapabilities?.host) {
        for (const entry of this.incoming.values()) {
          entry.control?.close();
          entry.control = undefined;
        }
      }
      this.screenControl.setAvailable(
        value.requestScreen === true &&
          this.controlCapabilities?.host === true,
      );
      if (!this.ready) {
        this.ready = true;
        this.trickleIce = value.trickleIce === true;
        this.multiScreen = value.multiScreen === true;
        this.controlCapabilities = parseControlCapabilities(
          value.remoteControl,
        );
        this.publishSelected();
      }
      return;
    }
    if (!this.ready) return;
    if (value.type === "control-cancel") {
      if (this.screenRequest?.id === value.id) {
        this.screenRequest.abort.abort();
        this.screenRequest = undefined;
        this.port.cancelScreenRequest?.();
      }
      return;
    }
    if (value.type === "control-request") {
      if (this.screenRequest?.id === value.id) return;
      this.screenRequest?.abort.abort();
      this.port.cancelScreenRequest?.();
      const request = {
        id: value.id,
        abort: new AbortController(),
      };
      this.screenRequest = request;
      let sourceId: string | undefined;
      try {
        if (this.localCapabilities?.host)
          sourceId = await this.port.requestScreen?.(
            request.abort.signal,
          );
      } catch (error) {
        this.port.error(error);
      }
      if (
        this.screenRequest === request &&
        !request.abort.signal.aborted
      )
        this.send({
          type: "control-result",
          id: value.id,
          ...(sourceId ? { sourceId } : {}),
        });
      return;
    }
    if (value.type === "control-result") {
      this.screenControl.result(value);
      this.attachRequestedControl();
      return;
    }
    if (value.type === "candidate") {
      const entry = this.findOutgoing(value.id);
      const outgoing = entry?.outgoing;
      if (entry?.publication.addIceCandidate && outgoing) {
        if (!outgoing.answerApplied) {
          if (outgoing.candidates.length >= 256)
            throw new Error(
              "Too many native ICE candidates",
            );
          outgoing.candidates.push(value.candidate);
        } else
          await entry.publication.addIceCandidate(
            value.id,
            value.candidate,
          );
      } else {
        const incoming = this.incoming.get(value.id);
        if (incoming?.receiver)
          await incoming.receiver.addIceCandidate(
            value.candidate,
          );
        else if (incoming) {
          if (incoming.candidates.length >= 256)
            throw new Error(
              "Too many native ICE candidates",
            );
          incoming.candidates.push(value.candidate);
        }
      }
      return;
    }
    if (value.type === "answer") {
      const entry = this.findOutgoing(value.id);
      const outgoing = entry?.outgoing;
      if (entry && outgoing) {
        clearTimeout(entry.timer);
        entry.timer = undefined;
        try {
          await entry.publication.answer(
            value.id,
            value.sdp,
          );
          if (!this.current(entry, outgoing)) return;
          outgoing.answerApplied = true;
          for (const candidate of outgoing.candidates.splice(
            0,
          )) {
            if (!this.current(entry, outgoing)) return;
            await entry.publication.addIceCandidate?.(
              value.id,
              candidate,
            );
          }
        } catch (error) {
          if (this.current(entry, outgoing)) {
            this.port.error(error);
            this.retry(entry, value.id);
          }
        }
      }
      return;
    }
    if (value.type === "retry") {
      const entry = this.findOutgoing(value.id);
      if (entry) this.retry(entry, value.id);
      return;
    }
    if (value.type === "stop") {
      if (this.incoming.has(value.id))
        this.stopIncoming(value.id);
      return;
    }
    if (this.incoming.has(value.id)) return;
    if (!this.multiScreen) this.stopIncoming();
    else {
      for (const entry of this.incoming.values())
        if (entry.sourceId === value.sourceId)
          this.stopIncoming(entry.id);
    }
    if (this.incoming.size >= MAX_SCREENS)
      throw new Error(
        "Native screen receiver limit reached",
      );
    const incoming: Incoming = {
      id: value.id,
      sourceId: value.sourceId,
      candidates: [],
    };
    if (
      value.control === true &&
      this.controlCapabilities?.host
    )
      incoming.control = new RemotePointer(
        value.sourceId,
        value.id,
      );
    this.incoming.set(value.id, incoming);
    this.attachRequestedControl();
    const current = () =>
      this.incoming.get(value.id) === incoming;
    const failed = (error: unknown) => {
      if (!current()) return;
      this.stopIncoming(value.id);
      this.port.error(error);
      this.send({ type: "retry", id: value.id });
    };
    try {
      const servers = await this.port.loadIceServers();
      if (!current()) return;
      let answered = false;
      const pending: RTCIceCandidateInit[] = [];
      const onCandidate = (
        candidate: RTCIceCandidateInit,
      ) => {
        if (!current()) return;
        if (!answered) {
          if (pending.length < 256) pending.push(candidate);
        } else
          this.send({
            type: "candidate",
            id: incoming.id,
            candidate,
          });
      };
      const receiver = (incoming.receiver =
        new ScreenReceiver(
          {
            iceServers: servers,
            iceTransportPolicy: this.port.relayOnly()
              ? "relay"
              : "all",
          },
          (stream) => {
            if (!current()) return;
            if (stream) bindNativeScreenAudio(stream);
            incoming.stream = stream ?? undefined;
            this.changed();
          },
          failed,
          value.trickleIce === true
            ? onCandidate
            : undefined,
          incoming.control,
        ));
      for (const candidate of incoming.candidates.splice(0))
        await receiver.addIceCandidate(candidate);
      const sdp = await receiver.answer(value.sdp);
      if (!current()) {
        receiver.close();
        return;
      }
      this.send({ type: "answer", id: value.id, sdp });
      answered = true;
      pending.forEach(onCandidate);
      await receiver.connected();
    } catch (error) {
      failed(error);
    }
  }
  private attachRequestedControl() {
    for (const entry of this.incoming.values())
      if (entry.control)
        this.screenControl.attach(
          entry.sourceId,
          entry.control,
        );
  }
}
