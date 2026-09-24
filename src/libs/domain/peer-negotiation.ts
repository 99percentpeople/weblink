import { catchError } from "@/libs/catch";
import type {
  ClientSignal,
  SignalingService,
} from "@/libs/domain/signaling";

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
    // A closed PC can leave browser SDP operations pending. A new connection
    // gets its own queue; epoch checks keep late old completions harmless.
    this.signalProcessingTail = Promise.resolve();
    this.connectionGeneration = this.createGeneration();
    this.makingOffer = false;
    this.ignoreOffer = false;
    return this.connectionGeneration;
  }

  reset() {
    this.retireGeneration(this.connectionGeneration);
    this.connectionEpoch++;
    this.signalProcessingTail = Promise.resolve();
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
    const epoch = this.connectionEpoch;
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
    // Local SDP creation and remote SDP application must share one queue.
    // Otherwise polite rollback can adopt the remote generation between
    // createOffer and setLocalDescription, failing the whole connect attempt.
    const processing = this.signalProcessingTail
      .then(async () => {
        if (
          epoch !== this.connectionEpoch ||
          pc !== this.getPeerConnection()
        ) {
          throw new DOMException(
            "Peer connection replaced",
            "AbortError",
          );
        }
        // An earlier queued remote offer already won on this same PC. Continue
        // waiting for its connection rather than treating polite yielding as an error.
        if (generation !== this.connectionGeneration)
          return;
        await handleOffer(
          pc,
          this.sender,
          options,
          generation,
          () =>
            epoch === this.connectionEpoch &&
            pc === this.getPeerConnection() &&
            generation === this.connectionGeneration,
        );
      })
      .finally(() => {
        if (epoch === this.connectionEpoch)
          this.makingOffer = false;
      });
    this.signalProcessingTail = processing.catch(() => {});
    await processing;
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
        this.logFailure(pc, `handle ${signal.type}`, error);
      },
    );
    return this.signalProcessingTail;
  }

  async handleSignal(signal: ClientSignal) {
    const pc = this.getPeerConnection();
    if (!pc) {
      console.debug(
        "[PeerNegotiation] peer connection is null, skip signal",
      );
      return;
    }

    const generation = this.getSignalGeneration(
      signal.data,
    );
    if (this.isRetiredGeneration(generation)) {
      console.debug(
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
          { peerId: this.sender.targetClientId },
        );
        return;
      }

      const offerCollision =
        this.makingOffer || pc.signalingState !== "stable";
      this.ignoreOffer = !this.polite && offerCollision;
      if (this.ignoreOffer) {
        // Established peers reuse one generation for renegotiation. Rejecting
        // a colliding offer must not also discard our own answer and ICE.
        if (
          generation &&
          generation !== this.connectionGeneration
        ) {
          this.retireGeneration(generation);
        }
        console.debug(
          `[PeerNegotiation] offer ignored due to collision, signalingState: ${pc.signalingState}`,
        );
        return;
      }
      // Apply the accepted offer and implicit polite rollback as one operation.
      [err] = await catchError(
        pc.setRemoteDescription(
          new RTCSessionDescription({
            type: "offer",
            sdp: data.sdp,
          }),
        ),
      );
      if (err) {
        this.logFailure(pc, "apply remote offer", err);
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
        this.logFailure(pc, "create answer", err);
        return;
      }
      if (pc !== this.getPeerConnection()) return;

      if (!pc.localDescription) {
        console.warn(
          "[PeerNegotiation] local description unavailable",
          {
            peerId: this.sender.targetClientId,
            signalingState: pc.signalingState,
          },
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
        this.logFailure(pc, "send answer", err, true);
      }
      return;
    }

    if (signal.type === "answer") {
      const data =
        signal.data as SessionDescriptionSignalData;
      if (typeof data.sdp !== "string") {
        console.warn(
          "[PeerNegotiation] invalid answer payload",
          { peerId: this.sender.targetClientId },
        );
        return;
      }
      if (
        generation &&
        generation !== this.connectionGeneration
      ) {
        console.debug(
          `[PeerNegotiation] ignore answer for non-current generation ${generation}`,
        );
        return;
      }
      if (pc.signalingState !== "have-local-offer") {
        console.debug(
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
        this.logFailure(pc, "apply remote answer", err);
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
        { peerId: this.sender.targetClientId },
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
      this.logFailure(pc, "add ICE candidate", err);
    }
  }

  private logFailure(
    pc: RTCPeerConnection | null,
    operation: string,
    error: unknown,
    sending = false,
  ): void {
    // Closing/replacing a connection rejects pending browser operations. These
    // are cleanup details, not new failures of the replacement connection.
    if (
      pc !== this.getPeerConnection() ||
      pc?.signalingState === "closed" ||
      (sending && this.sender.status !== "connected")
    ) {
      console.debug(
        "[PeerNegotiation] operation interrupted",
        { peerId: this.sender.targetClientId, operation },
        error,
      );
      return;
    }

    console.error(
      "[PeerNegotiation] operation failed",
      {
        clientId: this.sender.clientId,
        peerId: this.sender.targetClientId,
        operation,
        signalingState: pc?.signalingState,
        generation: this.connectionGeneration,
      },
      error,
    );
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
        this.logFailure(
          pc,
          "add queued ICE candidate",
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
