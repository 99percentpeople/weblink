import { expect, it, vi } from "vitest";
import { MeetingCameraPeer } from "@/libs/application/meeting-camera-peer";
import type { MediaReceiverFactory } from "@/libs/domain/media-receiver";
import { ProtocolNegotiation } from "@/libs/domain/protocol/protocol-versions";

const camera = {
  video: ["video/vp8"],
  audio: ["audio/opus"],
};
const offer = (id: string) => ({
  type: "offer",
  id,
  sourceId: "camera",
  trickleIce: true,
  sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n",
});
function setup(
  loadIceServers = async (): Promise<RTCIceServer[]> => [],
) {
  const answers: string[] = [];
  const channel = Object.assign(new EventTarget(), {
    readyState: "open",
    bufferedAmount: 0,
    send: (value: string) => answers.push(value),
  });
  const deliver = (v: unknown) =>
    channel.dispatchEvent(
      new MessageEvent("message", {
        data: "camera " + JSON.stringify(v),
      }),
    );
  const connection = {
    stream: {} as MediaStream,
    answer: vi.fn(async () => "answer"),
    addIceCandidate: vi.fn(async () => {}),
    connected: vi.fn(async () => {}),
    close: vi.fn(),
    monitorDecode: vi.fn(),
    decodeFailed: vi.fn(),
    getVideoStats: vi.fn(),
  };
  const create = vi.fn<MediaReceiverFactory>(
    () => connection,
  );
  const accepts = vi.fn(() => true);
  const peer = new MeetingCameraPeer({
    createReceiver: create,
    accepts,
    loadIceServers,
    relayOnly: () => true,
    settings: vi.fn(),
    changed: vi.fn(),
    captureEnded: vi.fn(),
    error: vi.fn(),
  });
  peer.bind(channel as unknown as RTCDataChannel);
  return {
    peer,
    create,
    connection,
    answers,
    deliver,
    accepts,
  };
}

it("preserves ordinary meeting tracks for web viewers and peers without the capability", () => {
  const { peer } = setup();
  const ordinary = {} as MediaStream;
  expect(peer.route(ordinary)).toBe(ordinary);
  peer.setCapabilities({ camera: null });
  expect(peer.route(ordinary)).toBe(ordinary);
  const negotiate = (offer: unknown) =>
    new ProtocolNegotiation().project(
      { "meetingMedia/1": { camera: null } },
      offer ? { "meetingMedia/1": offer } : {},
    );
  expect(negotiate({ camera }).meetingMedia).toEqual({
    camera,
  });
  expect(
    negotiate({ camera: "yes" }).meetingMedia,
  ).toBeUndefined();
  expect(negotiate(undefined).meetingMedia).toBeUndefined();
  peer.dispose();
});

it("admits only negotiated, permitted camera offers without screen control or data channels", async () => {
  const { peer, accepts, deliver, create } = setup();
  deliver(offer("old"));
  peer.setCapabilities({ camera: null });
  accepts.mockReturnValue(false);
  deliver(offer("denied"));
  accepts.mockReturnValue(true);
  deliver({ ...offer("control"), control: true });
  deliver({
    ...offer("data"),
    sdp:
      offer("data").sdp +
      "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
  });
  expect(create).not.toHaveBeenCalled();
  deliver(offer("current"));
  await vi.waitFor(() =>
    expect(create).toHaveBeenCalledTimes(1),
  );
  peer.dispose();
});

it.each(["withdraw", "disconnect", "stop"])(
  "cancels a pending offer on %s without opening a late native receiver",
  async (action) => {
    let resolve!: (ice: RTCIceServer[]) => void;
    const { peer, create, answers, deliver } = setup(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    peer.setCapabilities({ camera: null });
    deliver(offer("pending"));
    if (action === "withdraw")
      peer.setCapabilities(undefined);
    if (action === "disconnect") peer.disconnect();
    if (action === "stop")
      deliver({ type: "stop", id: "pending" });
    resolve([]);
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
    expect(answers).toEqual([]);
    peer.dispose();
  },
);

it("queues ICE before the answer and ignores stale stops after a camera replacement", async () => {
  const { peer, connection, deliver } = setup();
  peer.setCapabilities({ camera: null });
  deliver(offer("first"));
  const ice = { candidate: "candidate:1", sdpMid: "0" };
  deliver({
    type: "candidate",
    id: "first",
    candidate: ice,
  });
  await vi.waitFor(() =>
    expect(connection.answer).toHaveBeenCalledOnce(),
  );
  expect(connection.addIceCandidate).toHaveBeenCalledWith(
    ice,
  );
  deliver(offer("second"));
  deliver({ type: "stop", id: "first" });
  await vi.waitFor(() =>
    expect(connection.answer).toHaveBeenCalledTimes(2),
  );
  expect(connection.close).toHaveBeenCalledTimes(1);
  peer.setCapabilities(undefined);
  expect(connection.close).toHaveBeenCalledTimes(2);
  peer.dispose();
});
