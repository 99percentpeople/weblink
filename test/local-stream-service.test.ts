import { describe, expect, it, vi } from "vitest";
import { createLocalStreamService } from "@/libs/services/local-stream-service";

class FakeMediaStreamTrack extends EventTarget {
  readonly id: string;
  readonly kind: "audio" | "video";
  contentHint = "";
  readonly stop = vi.fn();

  constructor(id: string, kind: "audio" | "video") {
    super();
    this.id = id;
    this.kind = kind;
  }

  end() {
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeMediaStream extends EventTarget {
  readonly id: string;
  private tracks: MediaStreamTrack[];

  constructor(id: string, tracks: MediaStreamTrack[] = []) {
    super();
    this.id = id;
    this.tracks = [...tracks];
  }

  getTracks() {
    return [...this.tracks];
  }

  addTrack(track: MediaStreamTrack) {
    if (this.tracks.includes(track)) return;
    this.tracks.push(track);
    this.dispatchTrackEvent("addtrack", track);
  }

  removeTrack(track: MediaStreamTrack) {
    const index = this.tracks.indexOf(track);
    if (index === -1) return;

    this.tracks.splice(index, 1);
    this.dispatchTrackEvent("removetrack", track);
  }

  private dispatchTrackEvent(
    type: "addtrack" | "removetrack",
    track: MediaStreamTrack,
  ) {
    const event = new Event(type);
    Object.defineProperty(event, "track", {
      value: track,
    });
    this.dispatchEvent(event);
  }
}

const asTrack = (
  track: FakeMediaStreamTrack,
): MediaStreamTrack => {
  return track as unknown as MediaStreamTrack;
};

const asStream = (stream: FakeMediaStream): MediaStream => {
  return stream as unknown as MediaStream;
};

describe("LocalStreamService", () => {
  it("stops the previous stream when replacing it", () => {
    const service = createLocalStreamService();
    const oldTrack = new FakeMediaStreamTrack(
      "old-audio",
      "audio",
    );
    const nextTrack = new FakeMediaStreamTrack(
      "next-video",
      "video",
    );
    const oldStream = new FakeMediaStream("old", [
      asTrack(oldTrack),
    ]);
    const nextStream = new FakeMediaStream("next", [
      asTrack(nextTrack),
    ]);

    service.replace(asStream(oldStream));
    service.replace(asStream(nextStream));

    expect(service.stream()).toBe(asStream(nextStream));
    expect(oldStream.getTracks()).toEqual([]);
    expect(oldTrack.stop).toHaveBeenCalledTimes(1);
    expect(nextTrack.stop).not.toHaveBeenCalled();

    oldTrack.end();
    expect(service.stream()).toBe(asStream(nextStream));

    service.dispose();

    expect(service.stream()).toBeNull();
    expect(nextTrack.stop).toHaveBeenCalledTimes(1);
  });

  it("removes ended tracks and clears an empty stream", () => {
    const service = createLocalStreamService();
    const audio = new FakeMediaStreamTrack(
      "audio",
      "audio",
    );
    const video = new FakeMediaStreamTrack(
      "video",
      "video",
    );
    const media = new FakeMediaStream("media", [
      asTrack(audio),
      asTrack(video),
    ]);

    service.replace(asStream(media));
    audio.end();

    expect(media.getTracks()).toEqual([asTrack(video)]);
    expect(service.stream()).toBe(asStream(media));

    video.end();

    expect(media.getTracks()).toEqual([]);
    expect(service.stream()).toBeNull();
  });

  it("observes tracks added after the stream is active", () => {
    const service = createLocalStreamService();
    const initial = new FakeMediaStreamTrack(
      "initial",
      "video",
    );
    const added = new FakeMediaStreamTrack(
      "added",
      "audio",
    );
    const media = new FakeMediaStream("dynamic", [
      asTrack(initial),
    ]);

    service.replace(asStream(media));
    media.addTrack(asTrack(added));
    added.end();

    expect(media.getTracks()).toEqual([asTrack(initial)]);
    expect(service.stream()).toBe(asStream(media));

    initial.end();

    expect(service.stream()).toBeNull();
  });

  it("ignores replacing a stream with itself", () => {
    const service = createLocalStreamService();
    const track = new FakeMediaStreamTrack(
      "audio",
      "audio",
    );
    const media = new FakeMediaStream("same", [
      asTrack(track),
    ]);

    service.replace(asStream(media));
    service.replace(asStream(media));

    expect(service.stream()).toBe(asStream(media));
    expect(track.stop).not.toHaveBeenCalled();
  });
});
