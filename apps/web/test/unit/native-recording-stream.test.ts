import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { NativeScreenShare } from "@weblink/platform";
import { openNativeRecordingStream } from "@/libs/application/native-recording-stream";
import { createNativeCodecSelection } from "@/libs/application/native-codec-selection";

const receivers = vi.hoisted(() => [] as any[]);
vi.mock("@/libs/domain/media-codecs", () => ({
  browserDecodeCapabilities: () => ({
    video: ["video/h264"],
    audio: ["audio/opus"],
  }),
}));
vi.mock(
  "@/libs/application/native-codec-selection",
  () => ({
    createNativeCodecSelection: vi.fn(async () => ({
      select: () => ({
        video: "video/h264",
        audio: "audio/opus",
      }),
    })),
  }),
);
vi.mock("@/libs/domain/native-screen/receiver", () => ({
  ScreenReceiver: class {
    stream = { id: Math.random() };
    constructor(
      _: unknown,
      __: unknown,
      readonly failed: (error: Error) => void,
    ) {
      receivers.push(this);
    }
    answer = vi.fn(async () => "answer");
    addIceCandidate = vi.fn(async () => {});
    connected = vi.fn(async () => {});
    decoded = vi.fn(async () => {});
    monitorDecode = vi.fn();
    close = vi.fn();
  },
}));

beforeEach(() => {
  receivers.length = 0;
  vi.mocked(createNativeCodecSelection).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
});
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function fixture() {
  const share = {
    offerRecording: vi.fn(
      async () => "reused" as string | null,
    ),
    offer: vi.fn(async () => "fallback"),
    closePeer: vi.fn(async () => {}),
    answer: vi.fn(async () => {}),
    addIceCandidate: vi.fn(async () => {}),
  } as unknown as NativeScreenShare;
  const controller = new AbortController();
  const ended = vi.fn();
  return {
    share,
    controller,
    ended,
    open: () =>
      openNativeRecordingStream(
        share,
        "capture",
        undefined,
        controller.signal,
        ended,
      ),
    end: (error: string | null) =>
      vi
        .mocked(share.offerRecording!)
        .mock.calls[0][4](error),
  };
}

it("prefers native sender reuse, verifies decoding, and closes only its own peer", async () => {
  const f = fixture();
  const recording = await f.open();
  expect(f.share.offer).not.toHaveBeenCalled();
  expect(createNativeCodecSelection).not.toHaveBeenCalled();
  expect(f.share.offerRecording).toHaveBeenCalledWith(
    "capture",
    expect.any(String),
    { video: ["video/h264"], audio: "audio/opus" },
    expect.any(Function),
    expect.any(Function),
  );
  expect(receivers[0].decoded).toHaveBeenCalledWith(4000);
  recording.close();
  await flush();
  expect(f.share.closePeer).toHaveBeenCalledWith(
    "capture",
    vi.mocked(f.share.offerRecording!).mock.calls[0][1],
  );
  expect(receivers[0].close).toHaveBeenCalledOnce();
  f.end(null);
  expect(f.ended).not.toHaveBeenCalled();
});

it.each(["missing", "unsupported", "failed", "decode"])(
  "falls back before recording when reuse is %s",
  async (reason) => {
    const f = fixture();
    if (reason === "missing") delete f.share.offerRecording;
    else if (reason === "unsupported")
      vi.mocked(f.share.offerRecording!).mockResolvedValue(
        null,
      );
    else if (reason === "failed")
      vi.mocked(f.share.offerRecording!).mockRejectedValue(
        new Error("unsupported"),
      );
    else
      vi.mocked(f.share.offerRecording!).mockImplementation(
        async () => {
          receivers[0].decoded.mockRejectedValue(
            new Error("cannot decode"),
          );
          return "reused";
        },
      );
    const recording = await f.open();
    expect(f.share.offer).toHaveBeenCalledOnce();
    expect(
      createNativeCodecSelection,
    ).toHaveBeenCalledOnce();
    expect(f.ended).not.toHaveBeenCalled();
    if (reason !== "missing") {
      expect(receivers[0].close).toHaveBeenCalledOnce();
      expect(
        vi.mocked(f.share.offer).mock.calls[0][1],
      ).not.toBe(
        vi.mocked(f.share.offerRecording!).mock.calls[0][1],
      );
    }
    recording.close();
  },
);

it("saves on borrowed sender end without closing the receiver before the final recorder data", async () => {
  const f = fixture();
  const recording = await f.open();
  f.end(null);
  f.end("late error");
  receivers[0].failed(
    new Error("later connection failure"),
  );
  expect(f.ended).toHaveBeenCalledOnce();
  expect(f.ended).toHaveBeenCalledWith(undefined);
  expect(receivers[0].close).not.toHaveBeenCalled();
  expect(f.share.offer).not.toHaveBeenCalled();
  recording.close();
  expect(receivers[0].close).toHaveBeenCalledOnce();
});

it("reports a relay overflow only to the active recording", async () => {
  const f = fixture();
  const recording = await f.open();
  f.end("Native recording cannot keep up with the sender");
  expect(f.ended).toHaveBeenCalledWith(
    expect.objectContaining({
      message: expect.stringContaining("cannot keep up"),
    }),
  );
  expect(f.share.offer).not.toHaveBeenCalled();
  recording.close();
});

it("cleans up late reuse completion after cancellation and never starts the fallback", async () => {
  const f = fixture();
  let resolve!: (value: string) => void;
  vi.mocked(f.share.offerRecording!).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const pending = f.open().catch((error) => error);
  await flush();
  f.controller.abort();
  resolve("late");
  await pending;
  await flush();
  expect(f.share.offer).not.toHaveBeenCalled();
  expect(f.ended).not.toHaveBeenCalled();
  expect(
    vi.mocked(f.share.closePeer).mock.calls.length,
  ).toBeGreaterThanOrEqual(2);
});

it("retries with the fallback if the borrowed sender ends during preparation", async () => {
  const f = fixture();
  vi.mocked(f.share.offerRecording!).mockImplementation(
    async (...args) => {
      args[4](null);
      return "ended";
    },
  );
  const recording = await f.open();
  expect(f.share.offer).toHaveBeenCalledOnce();
  expect(f.ended).not.toHaveBeenCalled();
  recording.close();
});
