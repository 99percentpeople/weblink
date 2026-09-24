import { PeerSession } from "../../../src/libs/domain/session";
import { MultiEventEmitter } from "../../../src/libs/utils/event-emitter";
import type {
  RawSignal,
  SignalingService,
  SignalingServiceEventMap,
  SignalingServiceStatus,
} from "../../../src/libs/domain/signaling";

declare global {
  interface Window {
    __SPEED_TEST_REPORT__?: unknown;
    __SPEED_TEST_ERROR__?: string;
  }
}
function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(message);
}
const trace: string[] = [];
const record = (message: string) => {
  trace.push(message);
  if (trace.length > 60) trace.shift();
};
async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
) {
  const deadline = performance.now() + 15000;
  while (!(await check())) {
    if (performance.now() > deadline)
      throw new Error(`Timed out: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

// Controllable signaling outage, with actual browser SDP, ICE, RTP and data
// channels. WebSocket join/replay ordering is covered by integration tests.
class Sender implements SignalingService {
  readonly events =
    new MultiEventEmitter<SignalingServiceEventMap>();
  status: SignalingServiceStatus = "connected";
  remote!: Sender;
  interruptOffer?: () => void;
  holdOffers = false;
  heldOffer?: RawSignal;
  constructor(
    readonly clientId: string,
    readonly targetClientId: string,
  ) {}
  addEventListener = this.events.addEventListener.bind(
    this.events,
  );
  removeEventListener =
    this.events.removeEventListener.bind(this.events);
  setStatus(
    status: Exclude<SignalingServiceStatus, "init">,
  ) {
    this.status = status;
    record(`${this.clientId} signaling ${status}`);
    this.events.dispatchEvent("statuschange", status);
  }
  async sendSignal(signal: RawSignal) {
    if (signal.type !== "candidate")
      record(
        `${this.clientId} sends ${signal.type}: ${JSON.parse(
          signal.data,
        )
          .sdp.split("\r\n")
          .filter((line: string) =>
            /^(m=|a=mid:|a=sctp-port:)/.test(line),
          )
          .join(" | ")}`,
      );
    if (signal.type === "offer" && this.interruptOffer) {
      const interrupt = this.interruptOffer;
      this.interruptOffer = undefined;
      interrupt();
    }
    if (
      this.status !== "connected" ||
      this.remote.status !== "connected"
    )
      throw new Error("Test signaling disconnected");
    if (signal.type === "offer" && this.holdOffers) {
      this.heldOffer = signal;
      return;
    }
    this.deliver(signal);
  }
  private deliver(signal: RawSignal) {
    queueMicrotask(() =>
      this.remote.events.dispatchEvent("signal", {
        ...signal,
        clientId: this.clientId,
        targetClientId: this.targetClientId,
        data: JSON.parse(signal.data),
      }),
    );
  }
  releaseOffer() {
    this.holdOffers = false;
    if (this.heldOffer) this.deliver(this.heldOffer);
    this.heldOffer = undefined;
  }
  close() {
    this.setStatus("closed");
    this.events.clearListeners();
  }
}
function videoSource(color: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 90;
  const context = canvas.getContext("2d")!;
  let frame = 0;
  const draw = () => {
    context.fillStyle = color;
    context.fillRect(0, 0, 160, 90);
    context.fillStyle = "white";
    context.fillText(String(frame++), 10, 30);
  };
  draw();
  const stream = canvas.captureStream(10);
  const timer = setInterval(draw, 75);
  return {
    track: stream.getVideoTracks()[0],
    close: () => {
      clearInterval(timer);
      stream.getTracks().forEach((track) => track.stop());
    },
  };
}

async function main() {
  const camera = videoSource("green"),
    screen = videoSource("blue");
  const audio = new AudioContext();
  const destination = audio.createMediaStreamDestination();
  const oscillator = audio.createOscillator();
  oscillator.connect(destination);
  oscillator.start();
  const microphone = destination.stream.getAudioTracks()[0];
  const stream = new MediaStream([
    camera.track,
    screen.track,
    microphone,
  ]);
  let a!: PeerSession, b!: PeerSession;
  let sa!: Sender, sb!: Sender;
  let remote: MediaStream | null = null;
  let reverseRemote: MediaStream | null = null;
  const sdpFailures: string[] = [];
  const remoteTracks = () => remote?.getTracks() ?? [];
  const dispose = () => {
    a?.close();
    b?.close();
    sa?.close();
    sb?.close();
  };
  const createPair = async () => {
    sa = new Sender("a", "b");
    sb = new Sender("b", "a");
    sa.remote = sb;
    sb.remote = sa;
    a = new PeerSession(sa, {
      polite: false,
      iceServers: [],
    });
    b = new PeerSession(sb, {
      polite: true,
      iceServers: [],
    });
    for (const session of [a, b]) {
      session.addEventListener("statuschange", (event) =>
        record(
          `${session.clientId} session ${event.detail}`,
        ),
      );
      session.addEventListener(
        "peerconnectioninit",
        (event) => {
          const pc = event.detail;
          const observe =
            <T>(
              method: string,
              apply: (description: T) => Promise<void>,
            ) =>
            async (description: T) => {
              try {
                await apply(description);
              } catch (error) {
                const failure = `${session.clientId} ${method}: ${String(error)}`;
                sdpFailures.push(failure);
                record(failure);
                throw error;
              }
            };
          pc.setLocalDescription = observe(
            "setLocalDescription",
            pc.setLocalDescription.bind(pc),
          );
          pc.setRemoteDescription = observe(
            "setRemoteDescription",
            pc.setRemoteDescription.bind(pc),
          );
          pc.addEventListener("connectionstatechange", () =>
            record(
              `${session.clientId} pc ${pc.connectionState}`,
            ),
          );
        },
      );
    }
    b.addEventListener("remotestreamchange", (event) => {
      remote = event.detail;
    });
    a.addEventListener("remotestreamchange", (event) => {
      reverseRemote = event.detail;
    });
    a.setStream(stream);
    await Promise.all([a.listen(), b.listen()]);
  };
  const ready = () =>
    a.peerConnection?.connectionState === "connected" &&
    b.peerConnection?.connectionState === "connected" &&
    a.isMessageChannelReady &&
    b.isMessageChannelReady;
  const mediaReady = async (videos = 2) => {
    if (
      !ready() ||
      remote?.getVideoTracks().length !== videos ||
      remote.getAudioTracks().length !== 1
    )
      return false;
    let decodedVideos = 0,
      receivedAudio = 0;
    (await b.peerConnection!.getStats()).forEach(
      (report) => {
        if (report.type !== "inbound-rtp") return;
        if (
          report.kind === "video" &&
          report.framesDecoded > 0
        )
          decodedVideos++;
        if (
          report.kind === "audio" &&
          report.bytesReceived > 0
        )
          receivedAudio++;
      },
    );
    return decodedVideos >= videos && receivedAudio >= 1;
  };
  const exerciseMediaChanges = async (label: string) => {
    const oldA = a.peerConnection!,
      oldB = b.peerConnection!;
    const extra = videoSource("purple");
    const stable = () =>
      ready() &&
      a.peerConnection?.signalingState === "stable" &&
      b.peerConnection?.signalingState === "stable";
    const decoded = async (
      session: PeerSession,
      view: MediaStream | null,
      count: number,
    ) => {
      const tracks = view?.getVideoTracks() ?? [];
      if (!stable() || tracks.length !== count)
        return false;
      const ids = new Set(tracks.map((track) => track.id));
      const received = new Set<string>();
      (await session.peerConnection!.getStats()).forEach(
        (report) => {
          if (
            report.type === "inbound-rtp" &&
            report.kind === "video" &&
            report.framesDecoded > 0 &&
            ids.has(report.trackIdentifier)
          )
            received.add(report.trackIdentifier);
        },
      );
      return received.size === count;
    };
    try {
      a.setStream(
        new MediaStream([camera.track, microphone]),
      );
      await until(
        () => decoded(b, remote, 1),
        `${label}: stop screen`,
      );
      sa.holdOffers = true;
      a.setStream(stream);
      await until(
        () => !!sa.heldOffer,
        `${label}: media offer is pending`,
      );
      a.setStream(
        new MediaStream([
          ...stream.getTracks(),
          extra.track,
        ]),
      );
      sa.releaseOffer();
      await until(
        () => decoded(b, remote, 3),
        `${label}: add another video while awaiting answer`,
      );
      // The former receive-only peer now becomes a media sender as well.
      b.setStream(new MediaStream([extra.track]));
      await until(
        () => decoded(a, reverseRemote, 1),
        `${label}: reverse video`,
      );
      b.setStream(null);
      await until(
        () => stable() && reverseRemote === null,
        `${label}: stop reverse video`,
      );
      a.setStream(null);
      await until(
        () => stable() && remote === null,
        `${label}: stop all media`,
      );
      a.setStream(stream);
      await until(
        () => decoded(b, remote, 2),
        `${label}: resume media`,
      );
      assert(
        a.peerConnection === oldA &&
          b.peerConnection === oldB,
        `${label}: media changes must not reconnect`,
      );
    } finally {
      extra.close();
    }
  };
  try {
    await audio.resume();
    await createPair();
    sa.interruptOffer = () => {
      sa.setStatus("disconnected");
      sb.setStatus("disconnected");
    };
    const error = await a.connect().then(
      () => null,
      (error) => error,
    );
    assert(error, "first negotiation was interrupted");
    sa.setStatus("connected");
    sb.setStatus("connected");
    await until(
      () => mediaReady(),
      "initial negotiation and all three media sources recover",
    );

    const stableA = a.peerConnection,
      stableB = b.peerConnection;
    sa.setStatus("disconnected");
    sb.setStatus("disconnected");
    sa.setStatus("connected");
    sb.setStatus("connected");
    await new Promise((resolve) =>
      setTimeout(resolve, 100),
    );
    assert(
      a.peerConnection === stableA &&
        b.peerConnection === stableB,
      "signaling-only outage should preserve working media",
    );

    // Both established peers now share one generation. Ignoring a colliding
    // offer must not retire that generation and discard the subsequent answer.
    sa.holdOffers = sb.holdOffers = true;
    // Actual local changes drive native negotiationneeded on both peers.
    a.peerConnection!.addTransceiver("video", {
      direction: "recvonly",
    });
    b.peerConnection!.addTransceiver("video", {
      direction: "recvonly",
    });
    await until(
      () => !!sa.heldOffer && !!sb.heldOffer,
      "established offers prepared",
    );
    sa.releaseOffer();
    sb.releaseOffer();
    await until(
      () =>
        a.peerConnection?.signalingState === "stable" &&
        b.peerConnection?.signalingState === "stable",
      "same-generation collision resolved",
    );
    assert(
      a.peerConnection === stableA &&
        b.peerConnection === stableB,
      "renegotiation must preserve both connections",
    );
    await until(
      () => mediaReady(),
      "media and data survive renegotiation collision",
    );

    // Both endpoints detect a broken transport, then regain signaling together.
    // Repeat to expose competing recovery loops and retired-connection races.
    for (let cycle = 0; cycle < 3; cycle++) {
      const oldA = a.peerConnection!,
        oldB = b.peerConnection!;
      sa.setStatus("disconnected");
      sb.setStatus("disconnected");
      oldA.close();
      oldB.close();
      oldA.dispatchEvent(
        new Event("connectionstatechange"),
      );
      oldB.dispatchEvent(
        new Event("connectionstatechange"),
      );
      await new Promise((resolve) =>
        setTimeout(resolve, 50),
      );
      sa.setStatus("connected");
      sb.setStatus("connected");
      await until(
        () => mediaReady(),
        `simultaneous reconnect ${cycle + 1}`,
      );
      assert(
        a.peerConnection !== oldA &&
          b.peerConnection !== oldB,
        "both peer connections rebuilt",
      );
      assert(
        stream
          .getTracks()
          .every((track) => track.readyState === "live"),
        "capture survives peer recovery",
      );
      assert(
        a
          .peerConnection!.getSenders()
          .filter((sender) => sender.track)
          .every((sender) =>
            stream.getTracks().includes(sender.track!),
          ),
        "same local capture tracks rebound",
      );
    }

    await exerciseMediaChanges(
      "after simultaneous recovery",
    );

    // Force both SDP offers to exist before either is delivered. This verifies
    // polite rollback rather than merely relying on different retry timings.
    sa.holdOffers = sb.holdOffers = true;
    const collision = Promise.all([
      a.reconnect({ initiate: true }),
      b.reconnect({ initiate: true }),
    ]);
    await until(
      () => !!sa.heldOffer && !!sb.heldOffer,
      "simultaneous offers prepared",
    );
    sa.releaseOffer();
    sb.releaseOffer();
    await collision;
    await until(
      () => mediaReady(),
      "simultaneous offer collision resolved",
    );
    await exerciseMediaChanges("after rollback recovery");

    // A fresh offer is a new PC session, not a renegotiation of the remote's
    // old SDP layout. Exercise both initiator roles and then change media.
    for (const initiator of [b, a]) {
      const oldA = a.peerConnection!,
        oldB = b.peerConnection!;
      await initiator.reconnect({ initiate: true });
      await until(
        () => mediaReady(),
        `one-sided reconnect ${initiator.clientId}`,
      );
      assert(
        a.peerConnection !== oldA &&
          b.peerConnection !== oldB,
        "one-sided restart replaces both peer connections",
      );
      await exerciseMediaChanges(
        `after one-sided recovery ${initiator.clientId}`,
      );
    }

    dispose();
    await createPair();
    await b.connect();
    await until(
      () => mediaReady(),
      "polite-only initiation restores media and data channels",
    );

    dispose();
    assert(
      stream
        .getTracks()
        .every((track) => track.readyState === "live"),
      "leave preserves capture",
    );
    // A source stopped by the user must stay off when the room is rejoined.
    camera.track.stop();
    await createPair();
    await a.connect();
    await until(
      () => mediaReady(1),
      "rejoin reuses screen and microphone without reopening stopped camera",
    );
    assert(
      sdpFailures.length === 0,
      `Unexpected SDP failures: ${sdpFailures.join("; ")}`,
    );
    return {
      ok: true,
      realRtp: true,
      mediaChangesAfterRecovery: true,
      mediaChangesWhileAwaitingAnswer: true,
      oneSidedRecoveryBothRoles: true,
      initialInterruptedJoinRecovered: true,
      signalingOnlyOutagePreservedMedia: true,
      simultaneousRecoveryCycles: 3,
      simultaneousOfferCollisionResolved: true,
      sameGenerationCollisionResolved: true,
      politeOnlyInitiationRecovered: true,
      cameraScreenAndAudioRecovered: true,
      sameCaptureTracksReused: true,
      manualLeaveRejoinPreservedCapture: true,
      stoppedCameraStayedOff: true,
    };
  } catch (error) {
    throw new Error(
      `${String(error)}\n${JSON.stringify({ trace, a: a?.peerConnection?.connectionState, b: b?.peerConnection?.connectionState, tracks: remoteTracks().map((track) => ({ kind: track.kind, ready: track.readyState })), messageA: a?.isMessageChannelReady, messageB: b?.isMessageChannelReady })}`,
    );
  } finally {
    dispose();
    camera.close();
    screen.close();
    microphone.stop();
    oscillator.stop();
    await audio.close();
  }
}
void main()
  .then((report) => {
    window.__SPEED_TEST_REPORT__ = report;
  })
  .catch((error) => {
    window.__SPEED_TEST_ERROR__ =
      error.stack ?? String(error);
  });
