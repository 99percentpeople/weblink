import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { createEffect, createRoot } from "solid-js";
import { createLocalStreamService } from "@/libs/application/local-stream-service";

class FakeMediaStreamTrack extends EventTarget {
  contentHint = "";
  readyState: MediaStreamTrackState = "live";
  readonly stop = vi.fn(() => {
    this.readyState = "ended";
  });
  constructor(
    readonly id: string,
    readonly kind: "audio" | "video",
  ) {
    super();
  }
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}

class FakeMediaStream extends EventTarget {
  private tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) {
    super();
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  addTrack(track: MediaStreamTrack) {
    if (!this.tracks.includes(track))
      this.tracks.push(track);
  }
  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter(
      (candidate) => candidate !== track,
    );
    // Browser MediaStream.addTrack/removeTrack do not dispatch track events
    // when directly called by application code.
  }
  addRemoteTrack(track: MediaStreamTrack) {
    this.addTrack(track);
    this.dispatchTrackEvent("addtrack", track);
  }
  removeRemoteTrack(track: MediaStreamTrack) {
    this.removeTrack(track);
    this.dispatchTrackEvent("removetrack", track);
  }
  private dispatchTrackEvent(
    type: "addtrack" | "removetrack",
    track: MediaStreamTrack,
  ) {
    const event = new Event(type);
    Object.defineProperty(event, "track", { value: track });
    this.dispatchEvent(event);
  }
}
const asTrack = (track: FakeMediaStreamTrack) =>
  track as unknown as MediaStreamTrack;
const stream = (...tracks: FakeMediaStreamTrack[]) =>
  new FakeMediaStream(
    tracks.map(asTrack),
  ) as unknown as MediaStream;
const cleanups: (() => void)[] = [];
function setup() {
  const service = createLocalStreamService();
  cleanups.push(service.dispose);
  return service;
}
beforeEach(() =>
  vi.stubGlobal("MediaStream", FakeMediaStream),
);
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

describe("LocalStreamService", () => {
  it("stops and removes only tracks absent from the replacement snapshot", () => {
    const service = setup();
    const mic = new FakeMediaStreamTrack("mic", "audio");
    const camera = new FakeMediaStreamTrack(
      "camera",
      "video",
    );
    const screen = new FakeMediaStreamTrack(
      "screen",
      "video",
    );
    const oldStream = stream(mic, camera);
    const nextStream = stream(mic, screen);
    service.replace(oldStream);
    service.replace(nextStream);
    expect(service.stream()).toBe(nextStream);
    expect(oldStream.getTracks()).toEqual([mic]);
    expect(mic.stop).not.toHaveBeenCalled();
    expect(camera.stop).toHaveBeenCalledOnce();
    expect(screen.stop).not.toHaveBeenCalled();
    camera.end();
    expect(service.stream()).toBe(nextStream);
    service.dispose();
    expect(service.stream()).toBeNull();
    expect(nextStream.getTracks()).toEqual([]);
    expect(mic.stop).toHaveBeenCalledOnce();
    expect(screen.stop).toHaveBeenCalledOnce();
  });

  it("publishes native ended changes to reactive consumers while preserving remaining track identity", () => {
    const service = setup();
    const audio = new FakeMediaStreamTrack(
      "audio",
      "audio",
    );
    const camera = new FakeMediaStreamTrack(
      "camera",
      "video",
    );
    const screen = new FakeMediaStreamTrack(
      "screen",
      "video",
    );
    const original = stream(audio, camera, screen);
    service.replace(original);
    const snapshots: MediaStreamTrack[][] = [];
    createRoot((dispose) => {
      createEffect(() => {
        snapshots.push(service.stream()?.getTracks() ?? []);
      });
      cleanups.push(dispose);
    });
    screen.end();
    const next = service.stream();
    expect(next).not.toBe(original);
    expect(next?.getTracks()).toEqual([audio, camera]);
    expect(original.getTracks()).toEqual([audio, camera]);
    expect(snapshots).toEqual([
      [audio, camera, screen],
      [audio, camera],
    ]);
    camera.end();
    expect(service.stream()?.getTracks()).toEqual([audio]);
    expect(audio.stop).not.toHaveBeenCalled();
    audio.end();
    expect(service.stream()).toBeNull();
    expect(snapshots.at(-1)).toEqual([]);
  });

  it("observes browser-added tracks in subsequent snapshots", () => {
    const service = setup();
    const initial = new FakeMediaStreamTrack(
      "initial",
      "video",
    );
    const added = new FakeMediaStreamTrack(
      "added",
      "audio",
    );
    const media = stream(initial);
    service.replace(media);
    (media as unknown as FakeMediaStream).addRemoteTrack(
      asTrack(added),
    );
    expect(service.stream()).not.toBe(media);
    expect(service.stream()?.getTracks()).toEqual([
      initial,
      added,
    ]);
    added.end();
    expect(service.stream()?.getTracks()).toEqual([
      initial,
    ]);
    expect(initial.stop).not.toHaveBeenCalled();
    initial.end();
    expect(service.stream()).toBeNull();
  });

  it("publishes browser-removal events without stopping another source", () => {
    const service = setup();
    const camera = new FakeMediaStreamTrack(
      "camera",
      "video",
    );
    const screen = new FakeMediaStreamTrack(
      "screen",
      "video",
    );
    const media = stream(camera, screen);
    service.replace(media);
    (media as unknown as FakeMediaStream).removeRemoteTrack(
      asTrack(screen),
    );
    expect(service.stream()).not.toBe(media);
    expect(service.stream()?.getTracks()).toEqual([camera]);
    expect(camera.stop).not.toHaveBeenCalled();
    camera.end();
    expect(service.stream()).toBeNull();
  });

  it("retains tracks only by object identity even when IDs happen to match", () => {
    const service = setup();
    const old = new FakeMediaStreamTrack(
      "same-id",
      "video",
    );
    const next = new FakeMediaStreamTrack(
      "same-id",
      "video",
    );
    service.replace(stream(old));
    service.replace(stream(next));
    expect(old.stop).toHaveBeenCalledOnce();
    expect(next.stop).not.toHaveBeenCalled();
    old.end();
    expect(service.stream()?.getTracks()).toEqual([next]);
  });

  it("ignores replacing a stream with itself and normalizes an empty stream", () => {
    const service = setup();
    const track = new FakeMediaStreamTrack(
      "audio",
      "audio",
    );
    const media = stream(track);
    service.replace(media);
    service.replace(media);
    expect(service.stream()).toBe(media);
    expect(track.stop).not.toHaveBeenCalled();
    service.replace(stream());
    expect(service.stream()).toBeNull();
    expect(track.stop).toHaveBeenCalledOnce();
  });
});
