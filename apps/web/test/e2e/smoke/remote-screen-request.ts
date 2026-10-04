import { RemoteControlHost } from "@/libs/application/remote-control-host";
import { createMeetingMediaController } from "@/libs/application/meeting-media-service";
import {
  NativeScreenSession,
  NATIVE_SCREEN_CHANNEL,
  type NativeScreenPublication,
} from "@/libs/domain/native-screen/session";
import {
  CONTROL_CHANNEL,
  POINTER_CHANNEL,
} from "@/libs/domain/remote-control/pointer";
import type {
  NativeControlStatus,
  PlatformRuntime,
} from "@weblink/platform";

const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};
async function until(
  check: () => boolean,
  message: string,
) {
  const end = performance.now() + 10000;
  while (!check()) {
    if (performance.now() > end) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
/** Real meeting/signaling/media DataChannels and RTP; only native capture/input are substituted. */
export async function remoteScreenRequestCheck() {
  let status: NativeControlStatus = {
    pending: null,
    clientId: null,
    closed: false,
  };
  let decision: "allow" | "deny" | undefined;
  let receive:
    | ((status: NativeControlStatus) => void)
    | undefined;
  let answer: ((accepted: boolean) => void) | undefined;
  let captures = 0,
    approvals = 0;
  const errors: unknown[] = [];
  const host = new RemoteControlHost(
    {
      getCapabilities: async () => ({ remoteInput: true }),
      remoteControl: {
        open: async () => "owner",
        end: async () => {},
        status: async () => ({ ...status }),
        watch: async (
          _owner: string,
          onStatus: (status: NativeControlStatus) => void,
        ) => {
          receive = onStatus;
          receive({ ...status });
          return () => {
            receive = undefined;
          };
        },
        revoke: async () => {
          status.clientId = null;
          receive?.({ ...status });
        },
        approve: async (
          _owner: string,
          id: string,
          accepted: boolean,
        ) => {
          assert(
            status.pending?.consentId === id,
            "Approval was not bound to the current request",
          );
          ++approvals;
          status.pending = null;
          answer?.(accepted);
          receive?.({ ...status });
        },
      },
    } as unknown as PlatformRuntime,
    {
      decision: () => decision,
      remember: (_client, next) => {
        decision = next;
      },
    },
  );
  host.start();
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const context = canvas.getContext("2d")!;
  let frame = 0;
  const draw = setInterval(() => {
    context.fillStyle = ++frame % 2 ? "blue" : "green";
    context.fillRect(0, 0, 320, 180);
  }, 80);
  const capture = canvas.captureStream(10);
  const mediaPeers = new Map<string, RTCPeerConnection>();
  const publication: NativeScreenPublication = {
    sourceId: "screen-1",
    controlEligible: true,
    offer: async (
      id,
      _servers,
      _relay,
      onCandidate,
      control,
    ) => {
      const pc = new RTCPeerConnection();
      mediaPeers.set(id, pc);
      pc.addTrack(capture.getVideoTracks()[0], capture);
      pc.onicecandidate = (e) => {
        if (e.candidate)
          onCandidate?.(e.candidate.toJSON());
      };
      if (control) {
        const channel = pc.createDataChannel(
          CONTROL_CHANNEL,
          { protocol: CONTROL_CHANNEL, ordered: true },
        );
        pc.createDataChannel(POINTER_CHANNEL, {
          protocol: POINTER_CHANNEL,
          ordered: false,
          maxRetransmits: 0,
        });
        const target = {
          sourceId: control.sourceId,
          mediaId: id,
          geometryRevision: "geometry",
        };
        const send = (value: unknown) =>
          channel.send(JSON.stringify(value));
        channel.onopen = () =>
          send({
            type: "ready",
            target,
            generation: id,
            persistentControl: true,
          });
        channel.onmessage = (event) => {
          const value = JSON.parse(event.data);
          if (value.type === "request") {
            status.pending = {
              consentId: "native-consent",
              clientId: control.clientId,
              sourceId: control.sourceId,
              peerGeneration: control.peerGeneration,
            };
            answer = (accepted) => {
              if (accepted) {
                status.clientId = control.clientId;
                send({
                  type: "grant",
                  requestId: value.requestId,
                  target,
                  grantId: "grant",
                  leaseMs: 2000,
                });
              } else
                send({
                  type: "deny",
                  requestId: value.requestId,
                  reason: "declined",
                });
            };
            receive?.({ ...status });
          } else if (value.type === "heartbeat")
            send({
              type: "heartbeat",
              grantId: value.grantId,
            });
          else if (
            value.type === "input" &&
            value.event?.type === "activate"
          )
            send({
              type: "state",
              grantId: value.grantId,
              inputEpoch: value.inputEpoch,
              active: true,
            });
        };
      }
      await pc.setLocalDescription(await pc.createOffer());
      return pc.localDescription!.sdp;
    },
    answer: async (id, sdp) => {
      await mediaPeers
        .get(id)!
        .setRemoteDescription({ type: "answer", sdp });
    },
    addIceCandidate: async (id, candidate) => {
      await mediaPeers.get(id)!.addIceCandidate(candidate);
    },
    closePeer: async (id) => {
      mediaPeers.get(id)?.close();
      mediaPeers.delete(id);
    },
  };
  const pcs: RTCPeerConnection[] = [];
  const sessions: NativeScreenSession[] = [];
  const streams: (MediaStream | null)[] = [null, null];
  const senders: NativeScreenSession[] = [];
  let local: MediaStream | null = null;
  const media = createMeetingMediaController({
    getUserMedia: async () => {
      throw new Error("not used");
    },
    stream: () => local,
    replace: (stream) => {
      local = stream;
      senders.forEach((sender) =>
        sender.setPublication(publication),
      );
    },
    clear: () => {
      local = null;
    },
  });
  host.screen.share = async (signal) => {
    ++captures;
    await media.addSharing(async () => capture, signal);
    return local ? publication.sourceId : undefined;
  };
  const connect = async (index: number) => {
    const peerId = index ? "observer" : "viewer";
    const a = new RTCPeerConnection(),
      b = new RTCPeerConnection();
    pcs.push(a, b);
    a.onicecandidate = (e) => {
      if (e.candidate) void b.addIceCandidate(e.candidate);
    };
    b.onicecandidate = (e) => {
      if (e.candidate) void a.addIceCandidate(e.candidate);
    };
    const common = {
      loadIceServers: async () => [],
      relayOnly: () => false,
      error: (error: unknown) => errors.push(error),
    };
    const sender = new NativeScreenSession({
      ...common,
      changed: () => {},
      loadControlCapabilities: () =>
        host.capabilities(peerId),
      controlContext: () =>
        host.context("peer-generation", peerId),
      requestScreen: (signal) =>
        host.requestScreen(
          peerId,
          "peer-generation",
          signal,
        ),
      cancelScreenRequest: () =>
        host.screen.cancelPeer(peerId, "peer-generation"),
    });
    const receiver = new NativeScreenSession({
      ...common,
      controlCapabilities: { request: true, host: false },
      changed: (stream) => {
        streams[index] = stream;
      },
    });
    senders.push(sender);
    sessions.push(sender, receiver);
    b.ondatachannel = (e) => receiver.bind(e.channel);
    sender.bind(
      a.createDataChannel(NATIVE_SCREEN_CHANNEL, {
        protocol: NATIVE_SCREEN_CHANNEL,
      }),
    );
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription!);
    return receiver;
  };
  const videos: HTMLVideoElement[] = [];
  try {
    const viewer = await connect(0);
    await connect(1);
    await until(
      () => viewer.screenControl.state() === "viewing",
      "Avatar action unavailable without screen",
    );
    viewer.screenControl.request();
    await until(
      () => !!host.status().pending,
      "Missing share consent",
    );
    assert(
      captures === 0,
      "Capture started before consent",
    );
    viewer.screenControl.cancel();
    await until(
      () => !host.status().pending,
      "Cancelled request remained pending",
    );
    viewer.screenControl.request();
    await until(
      () => !!host.status().pending,
      "Second share request missing",
    );
    await host.approve(
      host.status().pending!.consentId,
      true,
    );
    await until(
      () => viewer.screenControl.state() === "active",
      "Screen request did not hand off to native control",
    );
    assert(
      captures === 1 && approvals === 1,
      "Capture or approval was duplicated",
    );
    await until(
      () => streams.every(Boolean),
      "Screen was not shared with every room member",
    );
    for (const stream of streams) {
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = stream;
      videos.push(video);
      document.body.append(video);
      await video.play();
      await until(
        () =>
          video.getVideoPlaybackQuality().totalVideoFrames >
          3,
        "Room viewer did not decode RTP",
      );
    }
    decision = "deny";
    await host.policyChanged("viewer");
    await senders[0].refreshControlCapabilities();
    await until(
      () =>
        viewer.remoteControlCapabilities?.host === false &&
        viewer.screenControl.state() === "unavailable",
      "Blocked viewer retained control capability",
    );
    decision = undefined;
    await senders[0].refreshControlCapabilities();
    await until(
      () => viewer.screenControl.state() === "viewing",
      "Removing rule did not restore request capability",
    );
    assert(
      errors.length === 0,
      `Screen signaling errors: ${errors}`,
    );
    return {
      captures,
      approvals,
      roomViewers: streams.length,
      cancelledBeforeCapture: true,
      capabilityRefresh: true,
    };
  } finally {
    sessions.forEach((session) => session.reset());
    host.close();
    media.dispose();
    pcs.forEach((pc) => pc.close());
    mediaPeers.forEach((pc) => pc.close());
    clearInterval(draw);
    capture.getTracks().forEach((track) => track.stop());
    videos.forEach((video) => {
      video.srcObject = null;
      video.remove();
    });
  }
}
