import { ScreenControlRequest } from "./control-request";
import type { PeerCapabilities } from "../protocol/capabilities";
import type { MediaDecodeCapabilities } from "../protocol/media-codecs";
import { RemotePointer } from "../remote-control/pointer";
import type { NativeControlContext } from "@weblink/platform";
import { ScreenReceiver } from "./receiver";
import {
  ScreenDecodeError,
  type NativeScreenView,
} from "./errors";
import { bindNativeScreenAudio } from "./tracks";
import { type ControlCapabilities } from "../protocol/remote-control";
import {
  readBrowserVideoStats,
  type VideoStatsBatch,
} from "../video-stats";

import {
  NativeScreenSender,
  type NativeScreenPublication,
} from "./sender";
import {
  MAX_NATIVE_SCREENS,
  parseScreenSignal,
  type ScreenSignal,
} from "./signaling";

export type { NativeScreenPublication } from "./sender";
export {
  NATIVE_SCREEN_CHANNEL,
  parseScreenSignal,
} from "./signaling";

interface ScreenSessionPort {
  clientId?: string;
  remoteDecodeChanged?(
    capabilities?: MediaDecodeCapabilities,
  ): void;
  requestScreen?(
    signal: AbortSignal,
  ): Promise<string | undefined>;
  /** Synchronous permission check, including before discovery has completed. */
  acceptsControlRequests?(): boolean;
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
  viewsChanged?(views: NativeScreenView[]): void;
  channelClosed?(): void;
  error(error: unknown): void;
}
type Incoming = {
  id: string;
  sourceId: string;
  receiver?: ScreenReceiver;
  control?: RemotePointer;
  stream?: MediaStream;
  candidates: RTCIceCandidateInit[];
  retired?: boolean;
};

/** Authenticated control channel; each source owns its media connection and retries.
 * Peer capabilities are supplied by the shared message-channel exchange. */
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
  private localReady = false;
  private capabilitiesRevision = 0;
  private controlRebindPending = false;
  private ready = false;
  private trickleIce = false;
  private multiScreen = false;
  private controlCapabilities?: ControlCapabilities;
  private remote?: PeerCapabilities;
  private deferred: ScreenSignal[] = [];
  get remoteControlCapabilities():
    | ControlCapabilities
    | undefined {
    return (
      this.controlCapabilities && {
        ...this.controlCapabilities,
      }
    );
  }
  private publications = new Map<
    string,
    NativeScreenSender
  >();
  private incoming = new Map<string, Incoming>();
  private views = new Map<string, NativeScreenView>();
  constructor(private readonly port: ScreenSessionPort) {}

  decodeFailed(track: MediaStreamTrack): void {
    for (const entry of this.incoming.values())
      if (entry.stream?.getVideoTracks().includes(track))
        entry.receiver?.decodeFailed();
  }

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
    const sender =
      publication &&
      this.publications.get(publication.sourceId);
    if (!sender || sender.publication !== publication)
      return [];
    return sender.getVideoStats();
  }

  bind(channel: RTCDataChannel): void {
    if (channel === this.channel) return;
    this.reset();
    this.channel = channel;
    const listeners = (this.listeners =
      new AbortController());
    const prepared = (
      revision: number,
      capabilities?: ControlCapabilities,
    ) => {
      if (
        this.channel !== channel ||
        listeners.signal.aborted ||
        revision !== this.capabilitiesRevision
      )
        return;
      this.localCapabilities = capabilities;
      this.localReady = true;
      this.publishSelected();
    };
    const open = () => {
      this.ready = true;
      this.applyRemoteCapabilities();
      const revision = ++this.capabilitiesRevision;
      if (this.port.loadControlCapabilities)
        void this.port
          .loadControlCapabilities()
          .then((capabilities) =>
            prepared(revision, capabilities),
          )
          .catch((error) => {
            this.port.error(error);
            prepared(revision);
          });
      else
        prepared(revision, this.port.controlCapabilities);
    };
    channel.addEventListener("open", open, {
      signal: listeners.signal,
    });
    channel.addEventListener(
      "close",
      () => {
        if (this.channel !== channel) return;
        this.reset();
        this.port.channelClosed?.();
      },
      {
        signal: listeners.signal,
      },
    );
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

  async refreshControlCapabilities(
    rebind = false,
  ): Promise<void> {
    const channel = this.channel;
    if (!channel || channel.readyState !== "open") return;
    // A newer policy read may overtake an owner change, but must still rebind it.
    this.controlRebindPending ||= rebind;
    const revision = ++this.capabilitiesRevision;
    let capabilities: ControlCapabilities | undefined;
    try {
      capabilities = this.port.loadControlCapabilities
        ? await this.port.loadControlCapabilities()
        : this.port.controlCapabilities;
    } catch (error) {
      this.port.error(error);
    }
    if (
      channel !== this.channel ||
      channel.readyState !== "open" ||
      revision !== this.capabilitiesRevision
    )
      return;
    const changed =
      this.canHostControl() !==
      (capabilities?.host === true &&
        this.controlCapabilities?.request === true);
    this.localCapabilities = capabilities;
    this.localReady = true;
    if (changed || this.controlRebindPending)
      this.restartControlSenders();
    this.controlRebindPending = false;
    this.publishSelected();
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
    if (next.size > MAX_NATIVE_SCREENS)
      throw new Error(
        "Native screen publication limit reached",
      );
    for (const [sourceId, entry] of this.publications) {
      if (next.get(sourceId) !== entry.publication) {
        entry.dispose();
        this.publications.delete(sourceId);
      }
    }
    for (const [sourceId, publication] of next) {
      if (!this.publications.has(sourceId))
        this.publications.set(
          sourceId,
          this.createSender(publication),
        );
    }
    this.publishSelected();
  }
  dispose(): void {
    this.setRemoteCapabilities(undefined);
    this.reset();
    for (const sender of this.publications.values())
      sender.dispose();
    this.publications.clear();
  }
  reset(): void {
    this.screenRequest?.abort.abort();
    this.screenRequest = undefined;
    this.port.cancelScreenRequest?.();
    this.screenControl.setAvailable(false);
    this.localCapabilities = undefined;
    this.localReady = false;
    this.controlRebindPending = false;
    ++this.capabilitiesRevision;
    this.listeners?.abort();
    this.listeners = undefined;
    const channel = this.channel;
    this.channel = undefined;
    this.ready = false;
    this.trickleIce = false;
    this.multiScreen = false;
    this.deferred = [];
    this.controlCapabilities = this.remote?.control;
    for (const sender of this.publications.values())
      sender.reset();
    this.stopIncoming();
    channel?.close();
  }
  private send(value: ScreenSignal): void {
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
    this.port.viewsChanged?.(
      [...this.views.values()].map((view) => ({ ...view })),
    );
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
  private stopIncoming(id?: string, preserve = false) {
    const entries = id
      ? [this.incoming.get(id)].filter(
          (entry): entry is Incoming => !!entry,
        )
      : [...this.incoming.values()];
    for (const incoming of entries) {
      incoming.retired = true;
      if (!preserve) this.incoming.delete(incoming.id);
      if (!preserve) this.views.delete(incoming.sourceId);
      if (incoming.control)
        this.screenControl.detach(incoming.control);
      incoming.control?.close();
      incoming.receiver?.close();
      if (preserve) {
        // Retain only identity/status until the replacement offer or explicit stop.
        incoming.receiver = undefined;
        incoming.control = undefined;
        incoming.stream = undefined;
      }
    }
    if (!id && !preserve) this.views.clear();
    this.changed();
  }
  private createSender(
    publication: NativeScreenPublication,
  ): NativeScreenSender {
    const sender: NativeScreenSender =
      new NativeScreenSender(publication, {
        ready: () =>
          this.ready &&
          this.localReady &&
          !!this.remote?.screen,
        selected: () => this.selected(sender),
        trickleIce: () => this.trickleIce,
        loadIceServers: () => this.port.loadIceServers(),
        relayOnly: () => this.port.relayOnly(),
        controlContext: async () => {
          const context =
            this.localCapabilities?.host &&
            this.controlCapabilities?.request &&
            publication.controlEligible
              ? await this.port.controlContext?.()
              : undefined;
          return context
            ? { ...context, sourceId: publication.sourceId }
            : undefined;
        },
        send: (signal) => this.send(signal),
        error: (error) => this.port.error(error),
      });
    return sender;
  }
  private selected(sender: NativeScreenSender): boolean {
    return (
      this.publications.get(sender.publication.sourceId) ===
        sender &&
      (this.multiScreen ||
        this.publications.values().next().value === sender)
    );
  }
  private publishSelected(): void {
    for (const sender of this.publications.values()) {
      if (this.selected(sender)) void sender.publish();
      else sender.stop();
    }
  }
  private restartControlSenders(): void {
    for (const sender of this.publications.values())
      sender.restartControl();
  }
  private canHostControl(): boolean {
    return (
      this.localCapabilities?.host === true &&
      this.controlCapabilities?.request === true
    );
  }
  private findOutgoing(
    id: string,
  ): NativeScreenSender | undefined {
    return [...this.publications.values()].find((sender) =>
      sender.owns(id),
    );
  }
  setRemoteCapabilities(
    services: PeerCapabilities | undefined,
  ): void {
    const couldHost = this.canHostControl();
    const couldRequest =
      this.controlCapabilities?.request === true;
    this.remote = services;
    this.controlCapabilities = services?.control;
    if (couldRequest && !services?.control?.request) {
      this.screenRequest?.abort.abort();
      this.screenRequest = undefined;
      this.port.cancelScreenRequest?.();
    }
    this.port.remoteDecodeChanged?.(
      services?.screen?.decode,
    );
    if (couldHost !== this.canHostControl())
      this.restartControlSenders();
    this.applyRemoteCapabilities();
  }
  private applyRemoteCapabilities(): void {
    this.trickleIce =
      this.remote?.screen?.trickleIce === true;
    this.multiScreen =
      this.remote?.screen?.multiScreen === true;
    this.screenControl.setAvailable(
      this.ready &&
        !!this.remote?.screen &&
        this.remote?.control?.host === true,
    );
    this.screenControl.setHostStatus(
      this.remote?.control?.occupancy,
      this.port.clientId ?? "",
    );
    for (const entry of this.incoming.values()) {
      if (this.remote && !this.remote.control?.host) {
        entry.control?.close();
        entry.control = undefined;
      } else
        entry.control?.setHostStatus(
          this.remote?.control?.occupancy,
          this.port.clientId ?? "",
        );
    }
    this.publishSelected();
    if (this.ready && this.remote) {
      const pending = this.deferred.splice(0);
      for (const value of pending)
        void this.handle(value).catch(this.port.error);
    }
  }
  private async handle(value: ScreenSignal) {
    if (
      value.type === "control-request" &&
      this.port.acceptsControlRequests?.() === false
    )
      return;
    if (!this.ready || !this.remote) {
      if (this.deferred.length >= 256)
        throw new Error("Too many pending media signals");
      this.deferred.push(value);
      return;
    }
    if (!this.remote.screen) return;
    if (
      value.type.startsWith("control-") &&
      !this.remote.control
    )
      return;
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
        !request.abort.signal.aborted &&
        this.port.acceptsControlRequests?.() !== false
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
      const sender = this.findOutgoing(value.id);
      if (sender) await sender.handle(value);
      else {
        const incoming = this.incoming.get(value.id);
        if (incoming?.retired) return;
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
    if (
      value.type === "answer" ||
      value.type === "retry" ||
      value.type === "receiver-status"
    ) {
      await this.findOutgoing(value.id)?.handle(value);
      return;
    }
    if (value.type === "stop") {
      if (this.incoming.has(value.id))
        this.stopIncoming(value.id, value.retry === true);
      return;
    }
    if (this.incoming.has(value.id)) return;
    if (!this.multiScreen) {
      for (const entry of this.incoming.values()) {
        this.stopIncoming(
          entry.id,
          entry.sourceId === value.sourceId,
        );
        this.incoming.delete(entry.id);
      }
    } else {
      for (const entry of this.incoming.values())
        if (entry.sourceId === value.sourceId) {
          this.stopIncoming(entry.id, true);
          this.incoming.delete(entry.id);
        }
    }
    if (this.incoming.size >= MAX_NATIVE_SCREENS)
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
    incoming.control?.setHostStatus(
      this.remote?.control?.occupancy,
      this.port.clientId ?? "",
    );
    this.incoming.set(value.id, incoming);
    this.views.set(value.sourceId, {
      sourceId: value.sourceId,
    });
    this.changed();
    this.attachRequestedControl();
    const current = () =>
      this.incoming.get(value.id) === incoming &&
      !incoming.retired;
    const failed = (error: unknown) => {
      if (
        !current() ||
        this.views.get(value.sourceId)?.error
      )
        return;
      const terminal = error instanceof ScreenDecodeError;
      const view = this.views.get(value.sourceId)!;
      view.error = terminal ? "codec" : "connection";
      incoming.retired = true;
      if (incoming.control)
        this.screenControl.detach(incoming.control);
      incoming.control?.close();
      incoming.receiver?.close();
      incoming.control = undefined;
      incoming.stream = undefined;
      this.changed();
      this.port.error(error);
      this.send(
        terminal
          ? {
              type: "receiver-status",
              id: value.id,
              state: "unsupported",
            }
          : { type: "retry", id: value.id },
      );
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
            const view = this.views.get(value.sourceId);
            if (view && stream) view.stream = stream;
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
      if (!current()) {
        receiver.close();
        return;
      }
      receiver.monitorDecode(() => {
        if (current())
          this.send({
            type: "receiver-status",
            id: value.id,
            state: "healthy",
          });
      });
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
