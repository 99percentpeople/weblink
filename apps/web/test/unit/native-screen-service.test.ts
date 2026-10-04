import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  CaptureStatus,
  NativeCapture,
  NativeScreenShare,
  NativeScreenPreview,
} from "@weblink/platform";
import {
  browserMediaStream,
  createNativeScreenStream,
  getNativeScreenPublication,
  getNativeCaptureStatus,
} from "@/libs/application/native-screen-service";
const receivers = vi.hoisted(() => [] as any[]);
let previewAudio = false;
class Track extends EventTarget {
  kind = "video";
  readyState = "live";
  stop = vi.fn(() => {
    this.readyState = "ended";
  });
}
class Stream {
  constructor(readonly tracks = [new Track()]) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter(
      (track) => track.kind === "video",
    );
  }
}
vi.mock("@/libs/domain/native-screen/receiver", () => ({
  ScreenReceiver: class {
    stream = new Stream(
      previewAudio
        ? [
            new Track(),
            Object.assign(new Track(), { kind: "audio" }),
          ]
        : [new Track()],
    );
    constructor(
      _: any,
      __: any,
      readonly failed: () => void,
    ) {
      receivers.push(this);
    }
    answer = vi.fn(async () => "answer");
    addIceCandidate = vi.fn(async () => {});
    connected = vi.fn(async () => {});
    close = vi.fn(() =>
      this.stream
        .getTracks()
        .forEach((track) => track.stop()),
    );
  },
}));
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
function setup() {
  let receive:
    | ((status: CaptureStatus) => void)
    | undefined;
  const status = {
    sessionId: "owned",
    state: "running",
  } as any;
  const capture: NativeCapture = {
    thumbnail: vi.fn(),
    backends: vi.fn(),
    sources: vi.fn(),
    start: vi.fn(),
    status: vi.fn(async () => status),
    renew: vi.fn(async () => {}),
    watch: vi.fn(async (_id, onStatus) => {
      receive = onStatus;
      onStatus(status);
      return vi.fn();
    }),
    stop: vi.fn(async () => status),
  };
  const share: NativeScreenShare = {
    updateVideoSettings: vi.fn(async () => {}),
    encoders: vi.fn(),
    setAudioEnabled: vi.fn(async () => {}),
    codecs: vi.fn(async () => ["video/vp8"]),
    start: vi.fn(async () => status),
    offer: vi.fn(async () => "offer"),
    answer: vi.fn(async () => {}),
    addIceCandidate: vi.fn(async () => {}),
    closePeer: vi.fn(async () => {}),
  };
  return {
    capture,
    share,
    emit: (status: CaptureStatus) => receive?.(status),
  };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("MediaStream", Stream);
  receivers.length = 0;
  previewAudio = false;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe("native preview ownership", () => {
  it("releases a raw preview that resolves after cancellation without reviving capture", async () => {
    const { capture, share } = setup();
    let finish!: (preview: any) => void;
    share.preview = vi.fn(
      () =>
        new Promise<NativeScreenPreview>((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const request = createNativeScreenStream(
      capture,
      share,
      "source",
      controller.signal,
    );
    const rejected = expect(request).rejects.toThrow(
      "Native screen closed",
    );
    await flush();
    controller.abort();
    const close = vi.fn();
    finish({ stream: new Stream(), close });
    await rejected;
    expect(close).toHaveBeenCalledOnce();
    expect(capture.stop).toHaveBeenCalledOnce();
  });

  it("survives repeated lease IPC errors and retains the pushed terminal diagnostic", async () => {
    const warn = vi
      .spyOn(console, "warn")
      .mockImplementation(() => {});
    const { capture, share, emit } = setup();
    const stream = await createNativeScreenStream(
      capture,
      share,
      "source",
    );
    const track = stream.getVideoTracks()[0];
    for (let i = 0; i < 4; i++) {
      vi.mocked(capture.renew).mockRejectedValueOnce(
        new Error("temporary IPC"),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      await vi.advanceTimersByTimeAsync(1000);
      expect(capture.stop).not.toHaveBeenCalled();
    }
    emit({
      state: "failed",
      sessionId: "owned",
      error: "audio failed",
      stopReason: "sourceClosed",
    } as any);
    await vi.advanceTimersByTimeAsync(1000);
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(getNativeCaptureStatus(track)).toMatchObject({
      state: "failed",
      error: "audio failed",
      stopReason: "sourceClosed",
    });
    warn.mockRestore();
  });
  it("uses raw preview without a local RTC peer and preserves remote publication and audio controls", async () => {
    const { capture, share } = setup();
    const video = new Track();
    const audio = Object.assign(new Track(), {
      kind: "audio",
    });
    const stopVideo = video.stop.bind(video);
    const raw = {
      stream: new Stream([
        video,
        audio,
      ]) as unknown as MediaStream,
      close: vi.fn(() => {
        stopVideo();
        audio.stop();
      }),
      stats: () => ({
        id: "raw",
        timestamp: 1000,
        width: 1920,
        height: 1080,
        frames: 60,
        implementation: "Shared memory / Canvas",
      }),
    };
    share.preview = vi.fn(async () => raw);
    const stream = await createNativeScreenStream(
      capture,
      share,
      "chosen",
      undefined,
      {
        audio: true,
        maxWidth: 1920,
        maxHeight: 1080,
        frameRate: 60,
        maxBitrate: 8_000_000,
        codec: "video/h264",
        degradationPreference: "balanced",
      },
    );
    expect(receivers).toHaveLength(0);
    expect(share.offer).not.toHaveBeenCalled();
    expect(browserMediaStream(stream)).toBeNull();
    expect(
      getNativeScreenPublication(
        audio as unknown as MediaStreamTrack,
      ),
    ).toBe(
      getNativeScreenPublication(
        stream.getVideoTracks()[0],
      ),
    );
    const publication = getNativeScreenPublication(
      stream.getVideoTracks()[0],
    )!;
    expect(
      (await publication.getPreviewStats!())[0].samples[0],
    ).toMatchObject({ frames: 60, width: 1920 });
    expect(await publication.getSenderStats!()).toEqual([]);
    await publication.setAudioEnabled!(false);
    expect(share.setAudioEnabled).toHaveBeenCalledWith(
      "owned",
      false,
    );
    await publication.offer("remote", [], false);
    expect(share.offer).toHaveBeenCalledWith(
      "owned",
      "remote",
      [],
      false,
    );
    stream.getVideoTracks()[0].stop();
    expect(raw.close).toHaveBeenCalledOnce();
    expect(audio.readyState).toBe("ended");
    expect(capture.stop).toHaveBeenCalledOnce();
  });

  it("releases capture if raw presentation cannot start instead of silently creating an encoder", async () => {
    const { capture, share } = setup();
    share.preview = vi.fn(async () => {
      throw new Error("preview unavailable");
    });
    await expect(
      createNativeScreenStream(capture, share, "chosen"),
    ).rejects.toThrow("preview unavailable");
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(share.offer).not.toHaveBeenCalled();
  });
  it("updates the owned session without restarting capture and ignores updates after stop", async () => {
    const { capture, share } = setup();
    const stream = await createNativeScreenStream(
      capture,
      share,
      "chosen",
    );
    const track = stream.getVideoTracks()[0];
    const publication = getNativeScreenPublication(track)!;
    const settings = {
      maxWidth: 1280,
      maxHeight: 720,
      frameRate: 60,
      maxBitrate: 2_000_000,
      degradationPreference: "balanced" as const,
    };
    await publication.updateVideoSettings!(settings);
    expect(share.updateVideoSettings).toHaveBeenCalledWith(
      "owned",
      settings,
    );
    expect(share.start).toHaveBeenCalledOnce();
    expect(capture.stop).not.toHaveBeenCalled();
    track.stop();
    await publication.updateVideoSettings!(settings);
    expect(
      share.updateVideoSettings,
    ).toHaveBeenCalledOnce();
  });
  it("passes native settings and budgets only the preview connection", async () => {
    const { capture, share } = setup();
    const options = {
      maxWidth: 1280,
      maxHeight: 720,
      frameRate: 60,
      maxBitrate: 4_000_000,
      codec: "video/vp8",
      degradationPreference: "maintain-framerate" as const,
    };
    const stream = await createNativeScreenStream(
      capture,
      share,
      "chosen",
      undefined,
      options,
      { backend: "wgc" },
    );
    expect(share.start).toHaveBeenCalledWith(
      "chosen",
      options,
      { backend: "wgc" },
    );
    expect(share.offer).toHaveBeenCalledWith(
      "owned",
      expect.any(String),
      [],
      false,
      true,
      expect.any(Function),
    );
    const publication = getNativeScreenPublication(
      stream.getVideoTracks()[0],
    )!;
    await publication.offer("remote", [], false);
    expect(share.offer).toHaveBeenLastCalledWith(
      "owned",
      "remote",
      [],
      false,
    );
    stream.getVideoTracks()[0].stop();
  });
  it("excludes the decoded preview from browser senders while retaining camera and microphone", async () => {
    const { capture, share } = setup();
    const native = await createNativeScreenStream(
      capture,
      share,
      "chosen",
    );
    const track = native.getVideoTracks()[0];
    expect(getNativeScreenPublication(track)).toBeDefined();
    expect(browserMediaStream(native)).toBeNull();
    const camera = new Track();
    const microphone = new Track();
    microphone.kind = "audio";
    const browser = new Stream([
      camera,
      microphone,
    ]) as unknown as MediaStream;
    expect(browserMediaStream(browser)).toBe(browser);
    const mixed = new Stream([
      camera,
      microphone,
      track as unknown as Track,
    ]) as unknown as MediaStream;
    expect(browserMediaStream(mixed)?.getTracks()).toEqual([
      camera,
      microphone,
    ]);
    track.stop();
    await flush();
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(camera.readyState).toBe("live");
  });
  it("stops native capture and notifies the shared owner exactly once when the preview is stopped", async () => {
    const { capture, share } = setup();
    const stream = await createNativeScreenStream(
      capture,
      share,
      "chosen",
    );
    const track = stream.getVideoTracks()[0];
    const ended = vi.fn();
    track.addEventListener("ended", ended);
    track.stop();
    track.stop();
    await vi.advanceTimersByTimeAsync(15000);
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(capture.stop).toHaveBeenCalledWith("owned");
    expect(ended).toHaveBeenCalledOnce();
    expect(track.readyState).toBe("ended");
  });
  it("cleans a capture whose negotiation fails and stops renewing its lease", async () => {
    const { capture, share } = setup();
    vi.mocked(share.offer).mockRejectedValue(
      new Error("ICE failed"),
    );
    await expect(
      createNativeScreenStream(capture, share, "chosen"),
    ).rejects.toThrow("ICE failed");
    const polls = vi.mocked(capture.renew).mock.calls
      .length;
    await vi.advanceTimersByTimeAsync(15000);
    expect(capture.stop).toHaveBeenCalledOnce();
    expect(capture.stop).toHaveBeenCalledWith("owned");
    expect(capture.renew).toHaveBeenCalledTimes(polls);
  });
  it("releases a start that resolves after its requesting room has left", async () => {
    const { capture, share } = setup();
    let resolve!: (value: any) => void;
    vi.mocked(share.start).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const controller = new AbortController();
    const request = createNativeScreenStream(
      capture,
      share,
      "chosen",
      controller.signal,
    );
    controller.abort();
    resolve({ sessionId: "owned", state: "running" });
    await expect(request).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(capture.stop).toHaveBeenCalledWith("owned");
    expect(share.offer).not.toHaveBeenCalled();
  });

  it("propagates native source closure to the local media owner", async () => {
    const { capture, share, emit } = setup();
    const stream = await createNativeScreenStream(
      capture,
      share,
      "chosen",
    );
    const track = stream.getVideoTracks()[0];
    const ended = vi.fn();
    track.addEventListener("ended", ended);
    emit({
      sessionId: "owned",
      state: "closed",
    } as any);
    await vi.advanceTimersByTimeAsync(1000);
    expect(ended).toHaveBeenCalledOnce();
    expect(track.readyState).toBe("ended");
  });
});

it("keeps preview audio out of browser senders and releases it with the screen", async () => {
  previewAudio = true;
  const { capture, share } = setup();
  const options = {
    audio: true,
    maxWidth: 1280,
    maxHeight: 720,
    frameRate: 30,
    maxBitrate: 4_000_000,
    codec: null,
    degradationPreference: "balanced" as const,
  };
  const stream = await createNativeScreenStream(
    capture,
    share,
    "chosen",
    undefined,
    options,
  );
  expect(share.start).toHaveBeenCalledWith(
    "chosen",
    options,
    undefined,
  );
  expect(receivers[0].connected).toHaveBeenCalledWith(true);
  expect(stream.getTracks()).toHaveLength(2);
  expect(browserMediaStream(stream)).toBeNull();
  const publication = getNativeScreenPublication(
    stream.getVideoTracks()[0],
  )!;
  await publication.setAudioEnabled!(false);
  await publication.setAudioEnabled!(true);
  expect(share.setAudioEnabled).toHaveBeenNthCalledWith(
    1,
    "owned",
    false,
  );
  expect(share.setAudioEnabled).toHaveBeenNthCalledWith(
    2,
    "owned",
    true,
  );
  stream.getVideoTracks()[0].stop();
  expect(
    stream
      .getTracks()
      .every((track) => track.readyState === "ended"),
  ).toBe(true);
  expect(capture.stop).toHaveBeenCalledOnce();
});
