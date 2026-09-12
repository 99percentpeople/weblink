import { catchError } from "@/libs/catch";
import {
  ClientSignal,
  SignalingService,
} from "@/libs/core/services/type";

const MAX_RETIRED_CONNECTION_GENERATIONS = 8;
const MAX_PENDING_CANDIDATE_GENERATIONS = 8;
const MAX_PENDING_CANDIDATES_PER_GENERATION = 256;

type NegotiationSignalData = {
  generation?: string;
};

type SessionDescriptionSignalData =
  NegotiationSignalData & {
    sdp: string;
  };

type CandidateSignalData = NegotiationSignalData & {
  candidate: RTCIceCandidateInit;
};

export type PeerNegotiationOptions = {
  sender: SignalingService;
  polite: boolean;
  getPeerConnection: () => RTCPeerConnection | null;
  createGeneration?: () => string;
};

function createGeneration() {
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export class PeerNegotiationController {
  private readonly sender: SignalingService;
  private readonly polite: boolean;
  private readonly getPeerConnection: () => RTCPeerConnection | null;
  private readonly createGeneration: () => string;

  private makingOffer = false;
  private ignoreOffer = false;
  private connectionGeneration: string | null = null;
  private readonly retiredConnectionGenerations =
    new Set<string>();
  private readonly pendingRemoteCandidates = new Map<
    string,
    RTCIceCandidateInit[]
  >();
  private signalProcessingTail: Promise<void> =
    Promise.resolve();
  private connectionEpoch = 0;

  constructor(options: PeerNegotiationOptions) {
    this.sender = options.sender;
    this.polite = options.polite;
    this.getPeerConnection = options.getPeerConnection;
    this.createGeneration =
      options.createGeneration ?? createGeneration;
  }

  get generation() {
    return this.connectionGeneration;
  }

  get isMakingOffer() {
    return this.makingOffer;
  }

  startConnection(pc: RTCPeerConnection) {
    if (pc !== this.getPeerConnection()) {
      throw new Error(
        "[PeerNegotiation] cannot start a non-current peer connection",
      );
    }
    this.retireGeneration(this.connectionGeneration);
    this.pendingRemoteCandidates.clear();
    this.connectionEpoch++;
    this.connectionGeneration = this.createGeneration();
    this.makingOffer = false;
    this.ignoreOffer = false;
    return this.connectionGeneration;
  }

  reset() {
    this.retireGeneration(this.connectionGeneration);
    this.connectionEpoch++;
    this.connectionGeneration = null;
    this.pendingRemoteCandidates.clear();
    this.makingOffer = false;
    this.ignoreOffer = false;
  }

  async sendOffer(
    pc: RTCPeerConnection,
    options?: RTCOfferOptions,
  ) {
    const generation = this.connectionGeneration;
    if (!generation || pc !== this.getPeerConnection()) {
      throw new Error(
        "[PeerNegotiation] peer connection generation is unavailable",
      );
    }
    if (this.makingOffer) {
      throw new Error(
        "[PeerNegotiation] offer creation already in progress",
      );
    }

    this.makingOffer = true;
    try {
      await handleOffer(
        pc,
        this.sender,
        options,
        generation,
        () =>
          pc === this.getPeerConnection() &&
          generation === this.connectionGeneration,
      );
    } finally {
      this.makingOffer = false;
    }
  }

  async sendCandidate(
    pc: RTCPeerConnection,
    candidate: RTCIceCandidateInit,
  ) {
    const generation = this.connectionGeneration;
    if (!generation || pc !== this.getPeerConnection()) {
      return;
    }

    await this.sender.sendSignal({
      type: "candidate",
      data: JSON.stringify({
        candidate,
        generation,
      } satisfies CandidateSignalData),
    });
  }

  enqueueSignal(signal: ClientSignal) {
    const connectionEpoch = this.connectionEpoch;
    const pc = this.getPeerConnection();
    const processing = this.signalProcessingTail.then(
      () => {
        if (
          connectionEpoch !== this.connectionEpoch ||
          pc !== this.getPeerConnection()
        ) {
          return;
        }
        return this.handleSignal(signal);
      },
    );
    this.signalProcessingTail = processing.catch(
      (error) => {
        console.error(
          "[PeerNegotiation] failed to process signaling message:",
          error,
        );
      },
    );
    return this.signalProcessingTail;
  }

  async handleSignal(signal: ClientSignal) {
    const pc = this.getPeerConnection();
    if (!pc) {
      console.log(
        "[PeerNegotiation] peer connection is null, skip signal",
      );
      return;
    }

    const generation = this.getSignalGeneration(
      signal.data,
    );
    if (this.isRetiredGeneration(generation)) {
      console.warn(
        `[PeerNegotiation] ignore stale ${signal.type} for retired generation ${generation}`,
      );
      return;
    }

    let err: Error | undefined;
    if (signal.type === "offer") {
      const data =
        signal.data as SessionDescriptionSignalData;
      if (typeof data.sdp !== "string") {
        console.warn(
          "[PeerNegotiation] invalid offer payload",
        );
        return;
      }

      const offerCollision =
        this.makingOffer || pc.signalingState !== "stable";
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) {
        if (generation) {
          this.retireGeneration(generation);
        }
        console.warn(
          `[PeerNegotiation] offer ignored due to collision, signalingState: ${pc.signalingState}`,
        );
        return;
      }
      if (offerCollision) {
        const [rollbackError] = await catchError(
          pc.setLocalDescription({ type: "rollback" }),
        );
        if (rollbackError) {
          console.warn(
            `[PeerNegotiation] rollback failed, signalingState: ${pc.signalingState}`,
            rollbackError,
          );
        }
        if (pc !== this.getPeerConnection()) return;
      }

      [err] = await catchError(
        pc.setRemoteDescription(
          new RTCSessionDescription({
            type: "offer",
            sdp: data.sdp,
          }),
        ),
      );
      if (err) {
        console.error(
          "[PeerNegotiation] setRemoteDescription error:",
          err,
        );
        return;
      }
      if (pc !== this.getPeerConnection()) return;

      if (generation) {
        this.adoptGeneration(generation);
      }
      await this.flushPendingRemoteCandidates(
        pc,
        this.connectionGeneration,
      );
      if (pc !== this.getPeerConnection()) return;

      [err] = await catchError(pc.setLocalDescription());
      if (err) {
        console.error(
          "[PeerNegotiation] setLocalDescription error:",
          err,
        );
        return;
      }
      if (pc !== this.getPeerConnection()) return;

      if (!pc.localDescription) {
        console.warn(
          `[PeerNegotiation] localDescription is null, signalingState: ${pc.signalingState}`,
        );
        return;
      }

      [err] = await catchError(
        this.sender.sendSignal({
          type: pc.localDescription.type,
          data: JSON.stringify({
            sdp: pc.localDescription.sdp,
            generation:
              this.connectionGeneration ?? undefined,
          } satisfies SessionDescriptionSignalData),
        }),
      );
      if (err) {
        console.error(
          "[PeerNegotiation] sendSignal error:",
          err,
        );
      }
      return;
    }

    if (signal.type === "answer") {
      const data =
        signal.data as SessionDescriptionSignalData;
      if (typeof data.sdp !== "string") {
        console.warn(
          "[PeerNegotiation] invalid answer payload",
        );
        return;
      }
      if (
        generation &&
        generation !== this.connectionGeneration
      ) {
        console.warn(
          `[PeerNegotiation] ignore answer for non-current generation ${generation}`,
        );
        return;
      }
      if (pc.signalingState !== "have-local-offer") {
        console.warn(
          `[PeerNegotiation] answer ignored due to signalingState is ${pc.signalingState}`,
        );
        return;
      }

      [err] = await catchError(
        pc.setRemoteDescription(
          new RTCSessionDescription({
            type: "answer",
            sdp: data.sdp,
          }),
        ),
      );
      if (err) {
        console.error(
          "[PeerNegotiation] setRemoteDescription error:",
          err,
        );
        return;
      }
      if (pc !== this.getPeerConnection()) return;

      await this.flushPendingRemoteCandidates(
        pc,
        this.connectionGeneration,
      );
      return;
    }

    if (signal.type !== "candidate") return;

    const data = signal.data as CandidateSignalData;
    if (
      typeof data.candidate !== "object" ||
      data.candidate === null
    ) {
      console.warn(
        "[PeerNegotiation] invalid candidate payload",
      );
      return;
    }

    const candidateGeneration =
      generation ?? this.connectionGeneration;
    if (!candidateGeneration) return;

    if (
      generation &&
      generation !== this.connectionGeneration
    ) {
      this.queueRemoteCandidate(generation, data.candidate);
      return;
    }

    if (!pc.remoteDescription) {
      this.queueRemoteCandidate(
        candidateGeneration,
        data.candidate,
      );
      return;
    }

    const candidate = new RTCIceCandidate(data.candidate);
    [err] = await catchError(pc.addIceCandidate(candidate));
    if (err && !this.ignoreOffer) {
      console.error(
        "[PeerNegotiation] addIceCandidate error:",
        err,
      );
    }
  }

  private retireGeneration(generation: string | null) {
    if (!generation) return;
    this.retiredConnectionGenerations.add(generation);
    this.pendingRemoteCandidates.delete(generation);

    while (
      this.retiredConnectionGenerations.size >
      MAX_RETIRED_CONNECTION_GENERATIONS
    ) {
      const oldest = this.retiredConnectionGenerations
        .values()
        .next().value;
      if (typeof oldest !== "string") break;
      this.retiredConnectionGenerations.delete(oldest);
    }
  }

  private adoptGeneration(generation: string) {
    if (this.connectionGeneration === generation) return;
    this.retireGeneration(this.connectionGeneration);
    this.connectionGeneration = generation;
  }

  private getSignalGeneration(
    data: unknown,
  ): string | null {
    if (typeof data !== "object" || data === null) {
      return null;
    }
    const generation = (data as NegotiationSignalData)
      .generation;
    return typeof generation === "string" && generation
      ? generation
      : null;
  }

  private isRetiredGeneration(generation: string | null) {
    return (
      generation !== null &&
      this.retiredConnectionGenerations.has(generation)
    );
  }

  private queueRemoteCandidate(
    generation: string,
    candidate: RTCIceCandidateInit,
  ) {
    const pending =
      this.pendingRemoteCandidates.get(generation) ?? [];
    pending.push(candidate);
    if (
      pending.length > MAX_PENDING_CANDIDATES_PER_GENERATION
    ) {
      pending.splice(
        0,
        pending.length -
          MAX_PENDING_CANDIDATES_PER_GENERATION,
      );
    }
    this.pendingRemoteCandidates.set(generation, pending);

    while (
      this.pendingRemoteCandidates.size >
      MAX_PENDING_CANDIDATE_GENERATIONS
    ) {
      const oldest = this.pendingRemoteCandidates
        .keys()
        .next().value;
      if (typeof oldest !== "string") break;
      if (oldest === this.connectionGeneration) {
        const current =
          this.pendingRemoteCandidates.get(oldest);
        this.pendingRemoteCandidates.delete(oldest);
        if (current) {
          this.pendingRemoteCandidates.set(oldest, current);
        }
        continue;
      }
      this.pendingRemoteCandidates.delete(oldest);
    }
  }

  private async flushPendingRemoteCandidates(
    pc: RTCPeerConnection,
    generation: string | null,
  ) {
    if (pc !== this.getPeerConnection()) return;
    if (!pc.remoteDescription || !generation) return;

    const pending =
      this.pendingRemoteCandidates.get(generation) ?? [];
    this.pendingRemoteCandidates.delete(generation);

    for (const candidateInit of pending) {
      if (pc !== this.getPeerConnection()) return;
      const candidate = new RTCIceCandidate(candidateInit);
      const [err] = await catchError(
        pc.addIceCandidate(candidate),
      );
      if (err && !this.ignoreOffer) {
        console.error(
          "[PeerNegotiation] addIceCandidate error:",
          err,
        );
      }
    }
  }
}

export async function handleOffer(
  pc: RTCPeerConnection,
  sender: SignalingService,
  options?: RTCOfferOptions,
  generation?: string,
  isCurrent: () => boolean = () => true,
) {
  const offer = await pc.createOffer(options);
  const sdp = offer.sdp;
  if (typeof sdp !== "string") {
    throw new Error(
      "[PeerNegotiation] offer SDP is unavailable",
    );
  }
  if (!isCurrent()) {
    throw new Error(
      "[PeerNegotiation] stale offer generation",
    );
  }

  await pc.setLocalDescription(offer);
  if (!isCurrent()) {
    throw new Error(
      "[PeerNegotiation] stale offer generation",
    );
  }
  await sender.sendSignal({
    type: offer.type,
    data: JSON.stringify({
      sdp,
      generation,
    } satisfies SessionDescriptionSignalData),
  });
}
