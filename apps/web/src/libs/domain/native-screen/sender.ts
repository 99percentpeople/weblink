import { createUuid } from "../ids";
import type {
  NativeControlContext,
  NativeVideoSettings,
} from "@weblink/platform";
import type {
  VideoStatsBatch,
  VideoStatsSample,
} from "../video-stats";
import type { ScreenSignal } from "./signaling";

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

interface ScreenSenderPort {
  ready(): boolean;
  selected(): boolean;
  trickleIce(): boolean;
  controlContext(): Promise<
    NativeControlContext | undefined
  >;
  loadIceServers(): Promise<RTCIceServer[]>;
  relayOnly(): boolean;
  send(signal: ScreenSignal): void;
  error(error: unknown): void;
}
type Outgoing = {
  id: string;
  answerApplied: boolean;
  candidates: RTCIceCandidateInit[];
};
type SenderSignal = Extract<
  ScreenSignal,
  {
    type:
      | "answer"
      | "candidate"
      | "retry"
      | "receiver-status";
  }
>;
const MAX_RETRIES = 3;

/** One publication's native transports; capture remains owned by the caller. */
export class NativeScreenSender {
  private outgoing?: Outgoing;
  // The receiver retains this card during backoff or an unfinished replacement.
  // Only an announced replacement or an explicit stop can retire its identity.
  private receiverId?: string;
  private retries = 0;
  private unsupported = false;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(
    readonly publication: NativeScreenPublication,
    private readonly port: ScreenSenderPort,
  ) {}

  owns(id: string): boolean {
    return this.outgoing?.id === id;
  }
  async getVideoStats(): Promise<VideoStatsBatch[]> {
    const outgoing = this.outgoing;
    if (!outgoing || !this.publication.getSenderStats)
      return [];
    return [
      {
        key: outgoing,
        direction: "send",
        samples: await this.publication.getSenderStats(
          outgoing.id,
        ),
      },
    ];
  }
  reset(): void {
    this.stop();
    this.retries = 0;
    this.unsupported = false;
  }
  restartControl(): void {
    if (
      !this.publication.controlEligible ||
      this.unsupported
    )
      return;
    this.stop(true);
    this.retries = 0;
  }
  private clearTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }
  stop(retry = false): void {
    this.clearTimer();
    const outgoing = this.outgoing;
    this.outgoing = undefined;
    const receiverId = this.receiverId;
    if (!retry) this.receiverId = undefined;
    try {
      if (receiverId)
        this.port.send({
          type: "stop",
          id: receiverId,
          ...(retry ? { retry: true as const } : {}),
        });
    } catch (error) {
      this.port.error(error);
    } finally {
      // Notify before closing native control, even when no replacement is ready.
      if (outgoing)
        void this.publication
          .closePeer(outgoing.id)
          .catch(() => {});
    }
  }
  private current(outgoing: Outgoing): boolean {
    return (
      this.port.selected() &&
      this.outgoing === outgoing &&
      this.retries <= MAX_RETRIES
    );
  }
  async publish(): Promise<void> {
    if (
      !this.port.ready() ||
      !this.port.selected() ||
      this.outgoing ||
      this.timer ||
      this.unsupported ||
      this.retries > MAX_RETRIES
    )
      return;
    const outgoing: Outgoing = {
      id: createUuid(),
      answerApplied: false,
      candidates: [],
    };
    this.outgoing = outgoing;
    try {
      const servers = await this.port.loadIceServers();
      if (!this.current(outgoing)) return;
      const trickle =
        this.port.trickleIce() &&
        !!this.publication.addIceCandidate;
      let offered = false;
      const pending: RTCIceCandidateInit[] = [];
      const onCandidate = (
        candidate: RTCIceCandidateInit,
      ) => {
        if (!this.current(outgoing)) return;
        if (!offered) {
          if (pending.length < 256) pending.push(candidate);
        } else
          this.port.send({
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
      const control = await this.port.controlContext();
      if (!this.current(outgoing)) return;
      const sdp = control
        ? await this.publication.offer(
            ...args,
            trickle ? onCandidate : undefined,
            control,
          )
        : trickle
          ? await this.publication.offer(
              ...args,
              onCandidate,
            )
          : await this.publication.offer(...args);
      if (!this.current(outgoing)) {
        await this.publication
          .closePeer(outgoing.id)
          .catch(() => {});
        return;
      }
      this.port.send({
        type: "offer",
        id: outgoing.id,
        sourceId: this.publication.sourceId,
        ...(control ? { control: true as const } : {}),
        sdp,
        ...(trickle ? { trickleIce: true as const } : {}),
      });
      this.receiverId = outgoing.id;
      offered = true;
      pending.forEach(onCandidate);
      this.timer = setTimeout(
        () => this.retry(outgoing.id),
        30000,
      );
    } catch (error) {
      if (this.current(outgoing)) {
        this.port.error(error);
        this.retry(outgoing.id);
      }
    }
  }
  private retry(id: string): void {
    if (!this.owns(id) || this.retries > MAX_RETRIES)
      return;
    if (++this.retries > MAX_RETRIES) {
      this.clearTimer();
      void this.publication.closePeer(id).catch(() => {});
      this.port.error(
        new Error(
          "Native screen could not connect; restart sharing to retry",
        ),
      );
      return;
    }
    this.stop(true);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.publish();
    }, 1000 * this.retries);
  }
  async handle(value: SenderSignal): Promise<void> {
    const outgoing = this.outgoing;
    if (
      !outgoing ||
      outgoing.id !== value.id ||
      this.retries > MAX_RETRIES
    )
      return;
    if (value.type === "candidate") {
      if (!this.publication.addIceCandidate) return;
      if (!outgoing.answerApplied) {
        if (outgoing.candidates.length >= 256)
          throw new Error("Too many native ICE candidates");
        outgoing.candidates.push(value.candidate);
      } else
        await this.publication.addIceCandidate(
          value.id,
          value.candidate,
        );
    } else if (value.type === "answer") {
      this.clearTimer();
      try {
        await this.publication.answer(value.id, value.sdp);
        if (!this.current(outgoing)) return;
        outgoing.answerApplied = true;
        for (const candidate of outgoing.candidates.splice(
          0,
        )) {
          if (!this.current(outgoing)) return;
          await this.publication.addIceCandidate?.(
            value.id,
            candidate,
          );
        }
      } catch (error) {
        if (this.current(outgoing)) {
          this.port.error(error);
          this.retry(value.id);
        }
      }
    } else if (value.type === "retry") {
      this.retry(value.id);
    } else if (value.state === "healthy") {
      if (outgoing.answerApplied) this.retries = 0;
    } else {
      // Retain remote identity until stop/restart, without retrying decode errors.
      this.clearTimer();
      this.retries = MAX_RETRIES + 1;
      this.unsupported = true;
      await this.publication.closePeer(value.id);
    }
  }
}
