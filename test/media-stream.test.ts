import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  composeMediaStream,
  mergeMediaStreamTracks,
  stopMediaStream,
} from "@/libs/core/media-stream";

class FakeMediaStream {
  private tracks: MediaStreamTrack[];

  constructor(tracks: MediaStreamTrack[] = []) {
    this.tracks = [...tracks];
  }

  getTracks() {
    return [...this.tracks];
  }

  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }

  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter(
      (current) => current !== track,
    );
  }
}

const createTrack = (
  id: string,
  kind: "audio" | "video",
) => {
  return {
    id,
    kind,
    contentHint: "",
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
};

const originalMediaStream = globalThis.MediaStream;

beforeEach(() => {
  Object.defineProperty(globalThis, "MediaStream", {
    configurable: true,
    value: FakeMediaStream,
    writable: true,
  });
});

afterEach(() => {
  Object.defineProperty(globalThis, "MediaStream", {
    configurable: true,
    value: originalMediaStream,
    writable: true,
  });
});

describe("media stream helpers", () => {
  it("combines one video, microphone, and program audio track", () => {
    const video = createTrack("video", "video");
    const microphone = createTrack("microphone", "audio");
    const programAudio = createTrack(
      "program-audio",
      "audio",
    );

    const stream = composeMediaStream([
      {
        stream: new FakeMediaStream([
          video,
        ]) as unknown as MediaStream,
        kind: "video",
        contentHint: "motion",
      },
      {
        stream: new FakeMediaStream([
          microphone,
        ]) as unknown as MediaStream,
        kind: "audio",
        contentHint: "speech",
      },
      {
        stream: new FakeMediaStream([
          programAudio,
        ]) as unknown as MediaStream,
        kind: "audio",
        contentHint: "music",
      },
    ]);

    expect(stream.getTracks()).toEqual([
      video,
      microphone,
      programAudio,
    ]);
    expect(video.contentHint).toBe("motion");
    expect(microphone.contentHint).toBe("speech");
    expect(programAudio.contentHint).toBe("music");
  });

  it("filters by kind and does not add a duplicate track", () => {
    const audio = createTrack("audio", "audio");
    const video = createTrack("video", "video");
    const target = new FakeMediaStream([
      audio,
    ]) as unknown as MediaStream;
    const source = new FakeMediaStream([
      audio,
      video,
    ]) as unknown as MediaStream;

    mergeMediaStreamTracks(target, source, {
      kind: "audio",
      contentHint: "speech",
    });

    expect(target.getTracks()).toEqual([audio]);
    expect(audio.contentHint).toBe("speech");
  });

  it("removes and stops every track", () => {
    const audio = createTrack("audio", "audio");
    const video = createTrack("video", "video");
    const stream = new FakeMediaStream([
      audio,
      video,
    ]) as unknown as MediaStream;

    stopMediaStream(stream);

    expect(stream.getTracks()).toEqual([]);
    expect(audio.stop).toHaveBeenCalledTimes(1);
    expect(video.stop).toHaveBeenCalledTimes(1);
  });
});
