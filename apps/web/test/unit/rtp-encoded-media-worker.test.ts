// @vitest-environment node
import { afterEach, expect, it, vi } from "vitest";
import { ENCODED_VIDEO_MAX_PENDING } from "@/libs/domain/encoded-video";
let close: (() => void) | undefined;
afterEach(() => {
  close?.();
  vi.unstubAllGlobals();
});
async function setup(kind = "video", direction = "send") {
  vi.resetModules();
  const scope = new EventTarget();
  vi.stubGlobal("self", scope);
  await import("@/libs/domain/rtp-encoded-media.worker");
  const channel = new MessageChannel();
  const messages: {
    id?: number;
    command?: string;
    packet?: {
      data: ArrayBuffer;
      type: string;
      segment: number;
    };
    error?: string;
  }[] = [];
  channel.port1.onmessage = ({ data }) => {
    messages.push(data);
  };
  const forwarded: RTCEncodedVideoFrame[] = [];
  const requestKeyFrame = vi.fn(async () => {});
  let controller!: ReadableStreamDefaultController<RTCEncodedVideoFrame>;
  scope.dispatchEvent(
    Object.assign(new Event("rtctransform"), {
      transformer: {
        options: { port: channel.port2, kind, direction },
        sendKeyFrameRequest: requestKeyFrame,
        readable: new ReadableStream({
          start(value) {
            controller = value;
          },
        }),
        writable: new WritableStream({
          write(frame) {
            forwarded.push(frame);
          },
        }),
      },
    }),
  );
  close = () => {
    controller.close();
    channel.port1.close();
    channel.port2.close();
  };
  const command = async (command: string, id = 1) => {
    const before = messages.length;
    channel.port1.postMessage({ command, id });
    await vi.waitFor(() =>
      expect(
        messages
          .slice(before)
          .some((message) => message.command === command),
      ).toBe(true),
    );
  };
  await command("start");
  await command("resume");
  return {
    messages,
    forwarded,
    command,
    controller,
    channel,
    requestKeyFrame,
  };
}
const frame = (
  type: "key" | "delta",
  bytes = 1,
  codec = "video/VP8",
) =>
  ({
    type,
    data: new ArrayBuffer(bytes),
    timestamp: 9000,
    getMetadata: () => ({
      mimeType: codec,
      width: 640,
      height: 360,
      synchronizationSource: 1,
    }),
  }) as unknown as RTCEncodedVideoFrame;
it.each(["video/VP8", "video/VP9", "video/AV1"])(
  "forwards %s originals and copies only keyframe-led recording segments, without pausing the network",
  async (codec) => {
    const f = await setup();
    const initial = [
      frame("delta", 1, codec),
      frame("key", 1, codec),
      frame("delta", 1, codec),
    ];
    initial.forEach((frame) => f.controller.enqueue(frame));
    await vi.waitFor(() =>
      expect(
        f.messages.filter((item) => item.packet),
      ).toHaveLength(2),
    );
    await f.command("pause");
    const paused = frame("key", 1, codec);
    f.controller.enqueue(paused);
    await vi.waitFor(() =>
      expect(f.forwarded).toHaveLength(4),
    );
    expect(
      f.messages.filter((item) => item.packet),
    ).toHaveLength(2);
    await f.command("resume");
    const resumed = [
      frame("delta", 1, codec),
      frame("key", 1, codec),
    ];
    resumed.forEach((frame) => f.controller.enqueue(frame));
    await vi.waitFor(() =>
      expect(
        f.messages.filter((item) => item.packet),
      ).toHaveLength(3),
    );
    expect(f.forwarded).toEqual([
      ...initial,
      paused,
      ...resumed,
    ]);
    expect(
      f.messages
        .filter((item) => item.packet)
        .map((item) => item.packet!.segment),
    ).toEqual([1, 1, 2]);
    expect(initial[1].data.byteLength).toBe(1);
  },
);
it("bounds unacknowledged bytes and disables only recording when the consumer cannot keep up", async () => {
  const f = await setup();
  const frames = [
    frame("key", ENCODED_VIDEO_MAX_PENDING),
    frame("delta"),
    frame("delta"),
  ];
  frames.forEach((frame) => f.controller.enqueue(frame));
  await vi.waitFor(() =>
    expect(f.forwarded).toHaveLength(3),
  );
  await vi.waitFor(() =>
    expect(
      f.messages.some((item) =>
        item.error?.includes("cannot keep up"),
      ),
    ).toBe(true),
  );
  expect(
    f.messages.filter((item) => item.packet),
  ).toHaveLength(1);
  expect(f.forwarded).toEqual(frames);
});
it("requests receiver keyframes and forwards every original through pause and resume", async () => {
  const f = await setup("video", "receive");
  expect(f.requestKeyFrame).toHaveBeenCalledOnce();
  const original = frame("key");
  f.controller.enqueue(original);
  await vi.waitFor(() =>
    expect(f.forwarded).toEqual([original]),
  );
  await f.command("pause");
  f.controller.enqueue(original);
  await vi.waitFor(() =>
    expect(f.forwarded).toHaveLength(2),
  );
  await f.command("resume");
  expect(f.requestKeyFrame).toHaveBeenCalledTimes(2);
});
it("copies Opus without a video keyframe and bounds tiny-packet queues while continuing normal audio", async () => {
  const f = await setup("audio", "receive");
  const original = {
    data: new Uint8Array([0xf8, 0xff, 0xfe]).buffer,
    timestamp: 1234,
    getMetadata: () => ({
      mimeType: "audio/opus",
      captureTime: 1000,
      senderCaptureTimeOffset: 20,
    }),
  } as unknown as RTCEncodedVideoFrame;
  for (let index = 0; index < 514; index++)
    f.controller.enqueue(original);
  await vi.waitFor(() =>
    expect(f.forwarded).toHaveLength(514),
  );
  await vi.waitFor(() =>
    expect(
      f.messages.some((entry) =>
        entry.error?.includes("cannot keep up"),
      ),
    ).toBe(true),
  );
  const packets = f.messages.filter(
    (entry) => entry.packet,
  );
  expect(packets).toHaveLength(512);
  expect(packets[0].packet).toMatchObject({
    mimeType: "audio/opus",
    clockTime: performance.timeOrigin + 1020,
    sampleRate: 48000,
    segment: 1,
  });
  expect(original.data.byteLength).toBe(3);
  expect(f.requestKeyFrame).not.toHaveBeenCalled();
});
it("a metadata/copy failure still forwards the current frame and all following frames", async () => {
  const f = await setup();
  const broken = Object.assign(frame("key"), {
    getMetadata() {
      throw new Error("Unavailable metadata");
    },
  });
  const following = frame("key");
  f.controller.enqueue(broken);
  f.controller.enqueue(following);
  await vi.waitFor(() =>
    expect(f.forwarded).toEqual([broken, following]),
  );
  await vi.waitFor(() =>
    expect(
      f.messages.some((item) =>
        item.error?.includes("Unavailable metadata"),
      ),
    ).toBe(true),
  );
  expect(
    f.messages.filter((item) => item.packet),
  ).toHaveLength(0);
});
