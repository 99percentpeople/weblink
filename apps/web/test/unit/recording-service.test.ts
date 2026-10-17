// @vitest-environment node
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  RecordingService,
  type RecordingSource,
  type RecordingState,
} from "@/libs/application/recording-service";
import { WebmRecordingMetadata } from "@/libs/application/recording-webm";
class Track extends EventTarget {
  kind = "video";
  readyState = "live";
  stop = vi.fn();
}
class Stream {
  constructor(private tracks: Track[]) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter(
      (track) => track.kind === "video",
    );
  }
  getAudioTracks() {
    return this.tracks.filter(
      (track) => track.kind === "audio",
    );
  }
}
class Recorder extends EventTarget {
  static isTypeSupported = vi.fn((_type?: string) => true);
  static automaticType = "video/webm;codecs=vp8,opus";
  static instances: Recorder[] = [];
  state = "inactive";
  mimeType: string;
  constructor(
    readonly stream: Stream,
    readonly options: MediaRecorderOptions,
  ) {
    super();
    this.mimeType =
      options.mimeType ?? Recorder.automaticType;
    if (!Recorder.isTypeSupported(this.mimeType))
      throw new DOMException(
        "Unsupported format",
        "NotSupportedError",
      );
    Recorder.instances.push(this);
  }
  start() {
    this.state = "recording";
  }
  pause = vi.fn(() => {
    this.state = "paused";
    queueMicrotask(() =>
      this.dispatchEvent(new Event("pause")),
    );
  });
  resume = vi.fn(() => {
    this.state = "recording";
    queueMicrotask(() =>
      this.dispatchEvent(new Event("resume")),
    );
  });
  data(text: string | Blob) {
    this.dispatchEvent(
      Object.assign(new Event("dataavailable"), {
        data:
          typeof text === "string"
            ? new Blob([text])
            : text,
      }),
    );
  }
  stop = vi.fn(() => {
    this.state = "inactive";
    queueMicrotask(() => {
      this.data("last");
      this.dispatchEvent(new Event("stop"));
    });
  });
}
const services: RecordingService[] = [];
beforeEach(() => {
  vi.stubGlobal("MediaStream", Stream);
  Recorder.instances = [];
  Recorder.automaticType = "video/webm;codecs=vp8,opus";
  Recorder.isTypeSupported
    .mockReset()
    .mockReturnValue(true);
});
afterEach(async () => {
  await Promise.all(
    services.splice(0).map((service) => service.stop()),
  );
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function fixture() {
  const data: string[] = [];
  const writer = {
    mountId: "indexeddb",
    write: vi.fn(async (bytes: Uint8Array) => {
      data.push(new TextDecoder().decode(bytes));
    }),
    finish: vi.fn(async () => ({
      id: "recorded",
      file: new File([data.join("")], "test.webm"),
    })),
    abort: vi.fn(async () => {}),
  };
  const port = {
    recorder: Recorder as unknown as typeof MediaRecorder,
    storage: {
      authorizeDefault: vi.fn(async () => {}),
      createWritableFile: vi.fn(
        async (_options: {
          name: string;
          type: string;
          signal?: AbortSignal;
        }) => writer,
      ),
    },
    changed:
      vi.fn<(state: RecordingState | null) => void>(),
    complete: vi.fn(async () => {}),
    failed: vi.fn(),
  };
  const service = new RecordingService(port);
  services.push(service);
  const video = new Track();
  const audio = Object.assign(new Track(), {
    kind: "audio",
  });
  const source: RecordingSource = {
    id: "source",
    name: "Screen",
    video: video as unknown as MediaStreamTrack,
    audio: [audio as unknown as MediaStreamTrack],
    available: vi.fn(() => true),
  };
  return {
    service,
    source,
    video,
    audio,
    data,
    writer,
    port,
    recorder: () => Recorder.instances[0],
  };
}
it("drains the final event and queued writes before publishing, and stops only once", async () => {
  const f = fixture();
  await f.service.start(f.source);
  expect(
    f.port.storage.authorizeDefault,
  ).toHaveBeenCalledWith({ refresh: false });
  f.recorder().data("first");
  const a = f.service.stop();
  const b = f.service.stop();
  expect(a).toBe(b);
  await a;
  expect(f.data.join("")).toBe("firstlast");
  expect(f.recorder().stop).toHaveBeenCalledOnce();
  expect(f.writer.finish).toHaveBeenCalledOnce();
  expect(f.port.complete).toHaveBeenCalledOnce();
  expect(f.video.stop).not.toHaveBeenCalled();
  expect(f.audio.stop).not.toHaveBeenCalled();
  expect(f.port.changed).toHaveBeenLastCalledWith(null);
});

it("leaves the format unset so received video can bypass re-encoding", async () => {
  const f = fixture();
  await f.service.start(f.source);
  expect(f.recorder().options).not.toHaveProperty(
    "mimeType",
  );
  expect(f.recorder().stream.getVideoTracks()).toEqual([
    f.video,
  ]);
});

it("lets local capture select accelerated codecs without changing its tracks", async () => {
  const f = fixture();
  f.source.local = true;
  await f.service.start(f.source);
  expect(f.recorder().options).toEqual({
    mimeType: "video/x-matroska",
    videoBitsPerSecond: 10_000_000,
  });
  expect(f.recorder().stream.getVideoTracks()).toEqual([
    f.video,
  ]);
  f.recorder().data(
    new Blob(["first"], {
      type: "video/x-matroska;codecs=avc1,opus",
    }),
  );
  await f.service.stop();
  expect(f.writer.finish).toHaveBeenCalledWith(
    expect.any(Array),
    expect.objectContaining({
      type: "video/x-matroska;codecs=avc1,opus",
      name: expect.stringMatching(/\.mkv$/),
    }),
  );
  expect(f.video.stop).not.toHaveBeenCalled();
  expect(f.audio.stop).not.toHaveBeenCalled();
});

it.each(["unsupported", "constructor failure"])(
  "falls back to automatic local recording after %s",
  async (failure) => {
    const f = fixture();
    f.source.local = true;
    let checks = 0;
    Recorder.isTypeSupported.mockImplementation(
      (type) =>
        type !== "video/x-matroska" ||
        (failure === "constructor failure" &&
          checks++ === 0),
    );
    await f.service.start(f.source);
    expect(f.recorder().options).not.toHaveProperty(
      "mimeType",
    );
    await f.service.stop();
    expect(f.port.complete).toHaveBeenCalledOnce();
    expect(f.port.failed).not.toHaveBeenCalled();
  },
);

it("keeps pass-through for a local native screen opened over WebRTC", async () => {
  const f = fixture();
  f.source.local = true;
  const close = vi.fn();
  f.source.open = vi.fn(async () => ({
    stream: new Stream([
      f.video,
      f.audio,
    ]) as unknown as MediaStream,
    close,
  }));
  await f.service.start(f.source);
  expect(f.recorder().options).not.toHaveProperty(
    "mimeType",
  );
  await f.service.stop();
  expect(close).toHaveBeenCalledOnce();
  expect(f.video.stop).not.toHaveBeenCalled();
});

it.each([
  ["video/x-matroska;codecs=avc1,opus", "mkv"],
  ["video/mp4;codecs=avc1", "mp4"],
  ["video/webm;codecs=vp9,opus", "webm"],
])(
  "publishes the actual first-chunk format %s using the original writer",
  async (type, extension) => {
    const f = fixture();
    Recorder.automaticType = "";
    await f.service.start(f.source);
    // The initial hint can differ from the container of the received video.
    f.recorder().mimeType = "video/webm;codecs=vp8,opus";
    f.recorder().data(new Blob(["first"], { type }));
    f.recorder().data("next");
    await f.service.stop();
    expect(
      f.port.storage.createWritableFile,
    ).toHaveBeenCalledOnce();
    expect(f.writer.finish).toHaveBeenCalledWith(
      extension === "mp4" ? undefined : expect.any(Array),
      expect.objectContaining({
        type,
        name: expect.stringMatching(
          new RegExp(`\\.${extension}$`),
        ),
      }),
    );
    expect(f.data.join("")).toBe("firstnextlast");
    expect(f.video.stop).not.toHaveBeenCalled();
    expect(f.audio.stop).not.toHaveBeenCalled();
  },
);

it("retains the draft and reports an unsupported actual format", async () => {
  const f = fixture();
  await f.service.start(f.source);
  f.recorder().data(
    new Blob(["unknown"], { type: "video/unknown" }),
  );
  await f.service.stop();
  expect(f.writer.write).not.toHaveBeenCalled();
  expect(f.writer.finish).not.toHaveBeenCalled();
  expect(f.writer.abort).toHaveBeenCalledOnce();
  expect(f.port.failed).toHaveBeenCalledWith(
    expect.objectContaining({
      message:
        "Unsupported recording format: video/unknown",
    }),
  );
  expect(f.video.stop).not.toHaveBeenCalled();
});

it("sizes recording quality from the opened video stream, not a native preview placeholder", async () => {
  const f = fixture();
  const actual = new Track();
  Object.assign(actual, {
    getSettings: () => ({
      width: 3840,
      height: 2160,
      frameRate: 60,
    }),
  });
  Object.assign(f.video, {
    getSettings: () => ({
      width: 320,
      height: 180,
      frameRate: 15,
    }),
  });
  f.source.open = async () => ({
    stream: new Stream([actual]) as unknown as MediaStream,
    close() {},
  });
  await f.service.start(f.source);
  expect(f.recorder().options.videoBitsPerSecond).toBe(
    40_000_000,
  );
  f.recorder().data("first");
  f.recorder().data("next");
  await f.service.stop();
  expect(Recorder.instances).toHaveLength(1);
  expect(f.recorder().stop).toHaveBeenCalledOnce();
  expect(f.data.join("")).toBe("firstnextlast");
});
it("pauses repeatedly without creating another file or recorder and excludes pauses from the saved duration", async () => {
  const f = fixture();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(
    () => now,
  );
  const metadata = vi.spyOn(
    WebmRecordingMetadata.prototype,
    "finish",
  );
  f.service.pause();
  f.service.resume();
  await f.service.start(f.source);
  now = 1000;
  f.recorder().data("before");
  f.service.pause();
  f.service.pause();
  expect(f.recorder().pause).toHaveBeenCalledOnce();
  expect(f.port.changed).toHaveBeenLastCalledWith(
    expect.objectContaining({
      phase: "paused",
      elapsed: 1000,
    }),
  );
  now = 11000;
  // Already accepted chunks can finish writing while capture remains paused.
  f.recorder().data("queued");
  await vi.waitFor(() =>
    expect(f.writer.write).toHaveBeenCalledTimes(2),
  );
  expect(f.port.changed).toHaveBeenLastCalledWith(
    expect.objectContaining({
      phase: "paused",
      elapsed: 1000,
    }),
  );
  expect(f.writer.finish).not.toHaveBeenCalled();
  expect(f.writer.abort).not.toHaveBeenCalled();
  f.service.resume();
  f.service.resume();
  expect(f.recorder().resume).toHaveBeenCalledOnce();
  now = 12000;
  f.service.pause();
  now = 22000;
  f.service.resume();
  now = 22500;
  f.recorder().data("after");
  const stopping = f.service.stop();
  f.service.pause();
  f.service.resume();
  await stopping;
  expect(metadata).toHaveBeenCalledWith(2500);
  expect(f.recorder().pause).toHaveBeenCalledTimes(2);
  expect(f.recorder().resume).toHaveBeenCalledTimes(2);
  expect(Recorder.instances).toHaveLength(1);
  expect(
    f.port.storage.createWritableFile,
  ).toHaveBeenCalledOnce();
  expect(f.data.join("")).toBe("beforequeuedafterlast");
  expect(f.writer.finish).toHaveBeenCalledOnce();
  expect(f.video.stop).not.toHaveBeenCalled();
  expect(f.audio.stop).not.toHaveBeenCalled();
});
it.each(["stop", "ended", "replaced", "resume-ended"])(
  "saves a paused recording when %s without resuming capture",
  async (action) => {
    const f = fixture();
    let now = 0;
    vi.spyOn(performance, "now").mockImplementation(
      () => now,
    );
    const metadata = vi.spyOn(
      WebmRecordingMetadata.prototype,
      "finish",
    );
    await f.service.start(f.source);
    f.recorder().data("before");
    now = 1200;
    f.service.pause();
    now = 11200;
    if (action === "ended")
      f.video.dispatchEvent(new Event("ended"));
    else if (
      action === "replaced" ||
      action === "resume-ended"
    ) {
      vi.mocked(f.source.available).mockReturnValue(false);
      if (action === "resume-ended") f.service.resume();
      else f.service.sync();
    }
    const first = f.service.stop();
    expect(f.service.stop()).toBe(first);
    await first;
    expect(f.recorder().resume).not.toHaveBeenCalled();
    expect(f.recorder().stop).toHaveBeenCalledOnce();
    expect(metadata).toHaveBeenCalledWith(1200);
    expect(f.data.join("")).toBe("beforelast");
    expect(f.writer.finish).toHaveBeenCalledOnce();
    expect(f.port.failed).not.toHaveBeenCalled();
  },
);
it.each(["pause", "resume"] as const)(
  "retains the draft and reports a %s failure",
  async (action) => {
    const f = fixture();
    await f.service.start(f.source);
    if (action === "resume") f.service.pause();
    const error = new DOMException(
      "Recorder operation failed",
      "InvalidStateError",
    );
    f.recorder()[action].mockImplementationOnce(() => {
      throw error;
    });
    f.service[action]();
    await f.service.stop();
    expect(f.port.failed).toHaveBeenCalledWith(error);
    expect(f.writer.abort).toHaveBeenCalledOnce();
    expect(f.writer.finish).not.toHaveBeenCalled();
  },
);
it("awaits slow accepted writes when stopped while paused and keeps completion pending", async () => {
  const f = fixture();
  let release!: () => void;
  f.writer.write.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  await f.service.start(f.source);
  f.recorder().data("first");
  await vi.waitFor(() =>
    expect(release).toBeTypeOf("function"),
  );
  f.service.pause();
  const stopped = f.service.stop();
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(f.writer.finish).not.toHaveBeenCalled();
  release();
  await stopped;
  expect(f.writer.finish).toHaveBeenCalledOnce();
});
it("retains a draft and reports the original disk failure", async () => {
  const f = fixture();
  const error = new DOMException(
    "disk full",
    "QuotaExceededError",
  );
  f.writer.write.mockRejectedValueOnce(error);
  await f.service.start(f.source);
  f.recorder().data("first");
  await vi.waitFor(() =>
    expect(f.port.failed).toHaveBeenCalledWith(error),
  );
  expect(f.writer.abort).toHaveBeenCalledOnce();
  expect(f.writer.finish).not.toHaveBeenCalled();
  expect(f.port.complete).not.toHaveBeenCalled();
});
it("bounds buffered media and stops rather than growing indefinitely", async () => {
  const f = fixture();
  await f.service.start(f.source);
  f.recorder().data(
    new Blob([new Uint8Array(32 * 1024 * 1024 + 1)]),
  );
  await vi.waitFor(() =>
    expect(f.port.failed).toHaveBeenCalled(),
  );
  expect(f.writer.write).not.toHaveBeenCalled();
  expect(f.writer.abort).toHaveBeenCalledOnce();
});
it("stops when the source is replaced or ends", async () => {
  const f = fixture();
  await f.service.start(f.source);
  vi.mocked(f.source.available).mockReturnValue(false);
  f.service.sync();
  await f.service.stop();
  expect(f.writer.finish).toHaveBeenCalledOnce();
  await f.service.start({
    ...f.source,
    available: () => true,
  });
  f.video.readyState = "ended";
  f.video.dispatchEvent(new Event("ended"));
  await f.service.stop();
  expect(f.writer.finish).toHaveBeenCalledTimes(2);
});
it("uses a dedicated native input and releases it without stopping the capture", async () => {
  const f = fixture();
  const close = vi.fn();
  const track = new Track();
  f.source.open = vi.fn(async () => ({
    stream: new Stream([track]) as unknown as MediaStream,
    close,
  }));
  await f.service.start(f.source);
  expect(f.recorder().stream.getVideoTracks()).toEqual([
    track,
  ]);
  await f.service.stop();
  expect(close).toHaveBeenCalledOnce();
  expect(f.video.stop).not.toHaveBeenCalled();
});
it("falls back to MP4 and matches stored metadata", async () => {
  const f = fixture();
  Recorder.isTypeSupported.mockImplementation(
    (type?: string) => type === "video/mp4",
  );
  await f.service.start(f.source);
  expect(
    f.port.storage.createWritableFile,
  ).toHaveBeenCalledWith(
    expect.objectContaining({
      type: "video/mp4",
      name: expect.stringMatching(/\.mp4$/),
    }),
  );
  await f.service.stop();
});
it("cancels preparation and closes a late native input without starting the recorder", async () => {
  const f = fixture();
  let resolve!: (input: {
    stream: MediaStream;
    close(): void;
  }) => void;
  f.source.open = vi.fn(
    () =>
      new Promise<{ stream: MediaStream; close(): void }>(
        (done) => {
          resolve = done;
        },
      ),
  );
  const start = f.service.start(f.source);
  await vi.waitFor(() =>
    expect(resolve).toBeTypeOf("function"),
  );
  f.service.pause();
  f.service.resume();
  const stop = f.service.stop();
  const close = vi.fn();
  resolve({
    stream: new Stream([]) as unknown as MediaStream,
    close,
  });
  await start;
  await stop;
  expect(close).toHaveBeenCalledOnce();
  expect(Recorder.instances).toHaveLength(0);
  expect(f.port.failed).not.toHaveBeenCalled();
});
it("rejects a second recording without affecting the active source", async () => {
  const f = fixture();
  await f.service.start(f.source);
  await expect(
    f.service.start({ ...f.source, id: "second" }),
  ).rejects.toThrow("already active");
  expect(f.recorder().state).toBe("recording");
  await f.service.stop();
});
it("reports failures before preparation without creating a writer", async () => {
  const f = fixture();
  f.video.readyState = "ended";
  await expect(f.service.start(f.source)).rejects.toThrow(
    "ended",
  );
  expect(f.port.failed).toHaveBeenCalledOnce();
  expect(
    f.port.storage.createWritableFile,
  ).not.toHaveBeenCalled();
});
it("keeps the output extension with a long source label", async () => {
  const f = fixture();
  await f.service.start({
    ...f.source,
    name: "Long camera label ".repeat(20),
  });
  const options = f.port.storage.createWritableFile.mock
    .calls[0][0] as unknown as { name: string };
  expect(options.name.length).toBeLessThan(120);
  expect(options.name).toMatch(/\.webm$/);
});
it("settles stop and reports cleanup failures without stopping borrowed tracks", async () => {
  const f = fixture();
  const error = new Error("native cleanup failed");
  f.source.open = async () => ({
    stream: new Stream([f.video]) as unknown as MediaStream,
    close() {
      throw error;
    },
  });
  await f.service.start(f.source);
  await f.service.stop();
  expect(f.port.failed).toHaveBeenCalledWith(error);
  expect(f.port.changed).toHaveBeenLastCalledWith(null);
  expect(f.video.stop).not.toHaveBeenCalled();
});
it("cancels audio preparation even if browser autoplay leaves resume pending", async () => {
  const f = fixture();
  const stopOutput = vi.fn();
  const close = vi.fn(async () => {});
  vi.stubGlobal(
    "AudioContext",
    class {
      destination = {};
      resume() {
        return new Promise<void>(() => {});
      }
      createMediaStreamDestination() {
        return {
          stream: {
            getTracks: () => [{ stop: stopOutput }],
          },
        };
      }
      createGain() {
        return {
          gain: { value: 1 },
          connect() {},
          disconnect() {},
        };
      }
      close = close;
    },
  );
  const start = f.service.start(f.source);
  const stop = f.service.stop();
  await Promise.all([start, stop]);
  expect(close).toHaveBeenCalledOnce();
  expect(stopOutput).toHaveBeenCalledOnce();
  expect(f.video.stop).not.toHaveBeenCalled();
  expect(f.audio.stop).not.toHaveBeenCalled();
  expect(f.port.failed).not.toHaveBeenCalled();
});
