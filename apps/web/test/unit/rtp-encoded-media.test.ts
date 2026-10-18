// @vitest-environment node
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  RtpEncodedMediaTrack,
  RtpEncodedMediaWorkers,
} from "@/libs/domain/rtp-encoded-media";
const fixture = vi.hoisted(() => ({
  workers: [] as { terminate: ReturnType<typeof vi.fn> }[],
}));
vi.mock(
  "@/libs/domain/rtp-encoded-media.worker?worker&inline",
  () => ({
    default: class extends EventTarget {
      terminate = vi.fn();
      constructor() {
        super();
        fixture.workers.push(this);
      }
    },
  }),
);
let ports: MessagePort[] = [];
let taps: RtpEncodedMediaTrack[] = [];
beforeEach(() => {
  vi.stubGlobal("Worker", class {});
  vi.stubGlobal(
    "RTCRtpScriptTransform",
    class {
      constructor(
        _worker: unknown,
        { port }: { port: MessagePort },
      ) {
        ports.push(port);
        port.onmessage = ({ data }) =>
          port.postMessage({
            id: data.id,
            command: data.command,
          });
      }
    },
  );
});
afterEach(() => {
  taps.forEach((tap) => tap.dispose());
  taps = [];
  ports.forEach((port) => port.close());
  ports = [];
  fixture.workers = [];
  vi.unstubAllGlobals();
});
function setup(workers?: RtpEncodedMediaWorkers) {
  const track = {
    kind: "video",
    readyState: "live",
    stop: vi.fn(),
  };
  const sender = {
    track,
    transform: null,
    getParameters: () => ({ encodings: [{}] }),
    setParameters: vi.fn(async () => {}),
  } as unknown as RTCRtpSender;
  const pc = Object.assign(new EventTarget(), {
    connectionState: "connected",
  });
  const tap = RtpEncodedMediaTrack.install(
    sender,
    pc as RTCPeerConnection,
    workers,
  )!;
  taps.push(tap);
  return { track, sender, pc, tap };
}
it("shares a worker across video senders and releases it only after its last owner", () => {
  const workers = new RtpEncodedMediaWorkers();
  const first = setup(workers),
    second = setup(workers);
  expect(fixture.workers).toHaveLength(1);
  first.tap.dispose();
  expect(
    fixture.workers[0].terminate,
  ).not.toHaveBeenCalled();
  second.tap.dispose();
  expect(
    fixture.workers[0].terminate,
  ).toHaveBeenCalledOnce();
});
it("pauses, drains and stops a subscription without detaching the sender or stopping capture", async () => {
  const { sender, track, tap } = setup();
  const original = sender.transform;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const frame = vi.fn(() => blocked);
  const subscription = tap.subscribe({
    frame,
    ended: vi.fn(),
  })!;
  subscription.resume();
  await vi.waitFor(() =>
    expect(sender.setParameters).toHaveBeenCalled(),
  );
  ports[0].postMessage({
    id: 1,
    packet: { data: new ArrayBuffer(100), type: "key" },
  });
  await vi.waitFor(() =>
    expect(frame).toHaveBeenCalledOnce(),
  );
  subscription.pause();
  let stopped = false;
  const done = subscription.stop().then(() => {
    stopped = true;
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(stopped).toBe(false);
  release();
  await done;
  expect(sender.transform).toBe(original);
  expect(
    fixture.workers[0].terminate,
  ).not.toHaveBeenCalled();
  expect(track.stop).not.toHaveBeenCalled();
  const again = tap.subscribe({
    frame: vi.fn(),
    ended: vi.fn(),
  })!;
  expect(again).not.toBeNull();
  await again.stop();
  tap.dispose();
  expect(
    fixture.workers[0].terminate,
  ).toHaveBeenCalledOnce();
});
it("reports a closed connection and retains the original borrowed track", async () => {
  const { pc, tap, track } = setup();
  const ended = vi.fn();
  const subscription = tap.subscribe({
    frame: vi.fn(),
    ended,
  })!;
  pc.connectionState = "disconnected";
  pc.dispatchEvent(new Event("connectionstatechange"));
  expect(ended).toHaveBeenCalledOnce();
  await subscription.stop();
  expect(
    tap.subscribe({ frame: vi.fn(), ended }),
  ).toBeNull();
  expect(track.stop).not.toHaveBeenCalled();
});
it("reports consumer failures while leaving the transform attached for network forwarding", async () => {
  const { tap, sender } = setup();
  const ended = vi.fn();
  const subscription = tap.subscribe({
    frame: async () => {
      throw new Error("Disk full");
    },
    ended,
  })!;
  subscription.resume();
  ports[0].postMessage({
    id: 1,
    packet: { data: new ArrayBuffer(1), type: "key" },
  });
  await vi.waitFor(() =>
    expect(ended).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Disk full" }),
    ),
  );
  await subscription.stop();
  expect(sender.transform).not.toBeNull();
  expect(
    fixture.workers[0].terminate,
  ).not.toHaveBeenCalled();
});
it("does not install or replace transforms when the browser lacks support or another transform owns the sender", () => {
  const { sender, pc } = setup();
  expect(
    RtpEncodedMediaTrack.install(
      sender,
      pc as RTCPeerConnection,
    ),
  ).toBeUndefined();
  vi.stubGlobal("RTCRtpScriptTransform", undefined);
  expect(
    RtpEncodedMediaTrack.install(
      { track: { kind: "video" } } as RTCRtpSender,
      pc as RTCPeerConnection,
    ),
  ).toBeUndefined();
});

it("borrows receiver Opus without sender controls and ends when the selected track ends", async () => {
  const track = Object.assign(new EventTarget(), {
    kind: "audio",
    readyState: "live",
    stop: vi.fn(),
  });
  const receiver = {
    track,
    getParameters: () => ({
      codecs: [
        {
          payloadType: 111,
          mimeType: "audio/opus",
          clockRate: 48000,
          channels: 2,
        },
      ],
    }),
    getSynchronizationSources: () => [
      {
        source: 1,
        timestamp: performance.now(),
        rtpTimestamp: 1234,
      },
    ],
  } as unknown as RTCRtpReceiver;
  const pc = Object.assign(new EventTarget(), {
    connectionState: "connected",
  });
  const tap = RtpEncodedMediaTrack.install(
    receiver,
    pc as RTCPeerConnection,
    undefined,
    "receive",
  )!;
  taps.push(tap);
  const encodedAudio = vi.fn(),
    frame = vi.fn(),
    ended = vi.fn();
  const subscription = tap.subscribe({
    frame,
    encodedAudio,
    ended,
  })!;
  subscription.resume();
  ports[0].postMessage({
    id: 1,
    packet: {
      data: new ArrayBuffer(3),
      sampleRate: 48000,
      timestamp: 1234,
      ssrc: 1,
      segment: 1,
    },
  });
  await vi.waitFor(() =>
    expect(encodedAudio).toHaveBeenCalledOnce(),
  );
  expect(encodedAudio.mock.calls[0][0].clockTime).toEqual(
    expect.any(Number),
  );
  expect(frame).not.toHaveBeenCalled();
  track.dispatchEvent(new Event("ended"));
  expect(ended).toHaveBeenCalledOnce();
  await subscription.stop();
  expect(receiver.transform).toBeDefined();
  expect(track.stop).not.toHaveBeenCalled();
});

it("fills AV1 receiver dimensions from existing inbound stats without creating a decoder", async () => {
  const receiver = {
    track: { kind: "video", readyState: "live" },
    getParameters: () => ({ codecs: [] }),
    getSynchronizationSources: () => [],
    getStats: vi.fn(
      async () =>
        new Map([
          [
            "video",
            {
              type: "inbound-rtp",
              ssrc: 9,
              frameWidth: 1280,
              frameHeight: 720,
            },
          ],
        ]),
    ),
  } as unknown as RTCRtpReceiver;
  const pc = Object.assign(new EventTarget(), {
    connectionState: "connected",
  });
  const tap = RtpEncodedMediaTrack.install(
    receiver,
    pc as RTCPeerConnection,
    undefined,
    "receive",
  )!;
  taps.push(tap);
  const frame = vi.fn(),
    subscription = tap.subscribe({
      frame,
      ended: vi.fn(),
    })!;
  for (const type of ["key", "delta"])
    ports[0].postMessage({
      id: 1,
      packet: {
        data: new ArrayBuffer(3),
        type,
        width: 0,
        height: 0,
        ssrc: 9,
      },
    });
  await vi.waitFor(() =>
    expect(frame).toHaveBeenCalledTimes(2),
  );
  for (const [packet] of frame.mock.calls)
    expect(packet).toMatchObject({
      width: 1280,
      height: 720,
    });
  expect(receiver.getStats).toHaveBeenCalledOnce();
  await subscription.stop();
});
