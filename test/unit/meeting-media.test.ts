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
import { createMeetingSources } from "@/routes/home/components/meeting-sources";
import { getMeetingAudioSource } from "@/libs/application/meeting-media-service";
import {
  createMeetingMediaController,
  getMeetingVideoSourceKind,
} from "@/routes/home/components/meeting-media";

let trackCounter = 0;
class FakeTrack extends EventTarget {
  readonly id = `track-${++trackCounter}`;
  contentHint = "";
  enabled = true;
  readyState: MediaStreamTrackState = "live";
  readonly stop = vi.fn(() => {
    this.readyState = "ended";
  });
  constructor(
    readonly kind: "audio" | "video",
    readonly source = "camera",
    readonly deviceId = "",
  ) {
    super();
  }
  clone() {
    const next = new FakeTrack(this.kind, this.source);
    next.enabled = this.enabled;
    next.contentHint = this.contentHint;
    return next as unknown as MediaStreamTrack;
  }
  getSettings() {
    return {
      ...(this.source === "screen"
        ? { displaySurface: "monitor" }
        : {}),
      ...(this.deviceId ? { deviceId: this.deviceId } : {}),
    };
  }
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}
class FakeStream extends EventTarget {
  tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) {
    super();
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getAudioTracks() {
    return this.tracks.filter(
      (track) => track.kind === "audio",
    );
  }
  getVideoTracks() {
    return this.tracks.filter(
      (track) => track.kind === "video",
    );
  }
  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter(
      (candidate) => candidate !== track,
    );
    // MediaStream.removeTrack is synchronous and does not emit removetrack
    // when invoked directly by application code.
  }
  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }
}
const asTrack = (track: FakeTrack) =>
  track as unknown as MediaStreamTrack;
const stream = (...tracks: FakeTrack[]) =>
  new FakeStream(
    tracks.map(asTrack),
  ) as unknown as MediaStream;
const deferred = () => {
  let resolve!: (value: MediaStream) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<MediaStream>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};
const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};
const cleanups: (() => void)[] = [];
function setup(initial: MediaStream | null = null) {
  const service = createLocalStreamService();
  service.replace(initial);
  const getUserMedia =
    vi.fn<
      (
        constraints: MediaStreamConstraints,
      ) => Promise<MediaStream>
    >();
  const getDisplayMedia =
    vi.fn<() => Promise<MediaStream>>();
  let media!: ReturnType<
    typeof createMeetingMediaController
  >;
  createRoot((dispose) => {
    media = createMeetingMediaController({
      stream: service.stream,
      replace: service.replace,
      clear: service.clear,
      getUserMedia,
      getDisplayMedia,
    });
    createEffect(media.sync);
    cleanups.push(() => {
      media.dispose();
      dispose();
      service.clear();
    });
  });
  return { service, media, getUserMedia, getDisplayMedia };
}
beforeEach(() => vi.stubGlobal("MediaStream", FakeStream));
afterEach(() => {
  cleanups.splice(0).forEach((cleanup) => cleanup());
  vi.unstubAllGlobals();
});

describe("meeting media controls", () => {
  it("only mutes existing outgoing audio without acquiring, replacing or stopping streams", async () => {
    const microphone = new FakeTrack("audio");
    const camera = new FakeTrack("video");
    const screen = new FakeTrack("video", "screen");
    const sharedAudio = new FakeTrack("audio");
    const f = setup(stream(microphone, camera));
    f.getDisplayMedia.mockResolvedValueOnce(
      stream(screen, sharedAudio),
    );
    await f.media.addSharing();
    const current = f.service.stream();
    f.media.setMicrophonePreference("next-device");
    f.media.setAudioEnabled(false);
    expect(f.media.audioAvailable()).toBe(true);
    expect(f.media.audioOn()).toBe(false);
    expect(f.media.microphoneOn()).toBe(false);
    expect(f.media.sharingAudioOn()).toBe(false);
    expect(microphone.enabled).toBe(false);
    expect(sharedAudio.enabled).toBe(false);
    f.media.setSharingAudioEnabled(true);
    expect(f.media.audioOn()).toBe(true);
    expect(microphone.enabled).toBe(false);
    f.media.setAudioEnabled(true);
    expect(microphone.enabled).toBe(true);
    expect(sharedAudio.enabled).toBe(true);
    expect(f.service.stream()).toBe(current);
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.getDisplayMedia).toHaveBeenCalledOnce();
    for (const track of [
      microphone,
      camera,
      screen,
      sharedAudio,
    ])
      expect(track.stop).not.toHaveBeenCalled();
    expect(camera.enabled).toBe(true);
    expect(screen.enabled).toBe(true);
  });

  it("does not start capture when changing sound without existing audio", () => {
    const f = setup();
    f.media.setAudioEnabled(true);
    f.media.setAudioEnabled(false);
    expect(f.media.audioAvailable()).toBe(false);
    expect(f.media.audioOn()).toBe(false);
    expect(f.service.stream()).toBeNull();
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.getDisplayMedia).not.toHaveBeenCalled();
  });

  it("reflects devices captured elsewhere and retains their selection after stopping", () => {
    const f = setup();
    const microphone = new FakeTrack(
      "audio",
      "camera",
      "external-mic",
    );
    const camera = new FakeTrack(
      "video",
      "camera",
      "external-camera",
    );
    f.service.replace(stream(microphone, camera));
    f.media.sync();
    expect(f.media.selectedMicrophoneId()).toBe(
      "external-mic",
    );
    expect(f.media.selectedCameraId()).toBe(
      "external-camera",
    );
    f.service.clear();
    f.media.sync();
    expect(f.media.selectedMicrophoneId()).toBe(
      "external-mic",
    );
    expect(f.media.selectedCameraId()).toBe(
      "external-camera",
    );
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });
  it("keeps the camera and multiple screens alongside the same muted microphone", async () => {
    const mic = new FakeTrack("audio");
    mic.contentHint = "speech";
    mic.enabled = false;
    const {
      media,
      service,
      getUserMedia,
      getDisplayMedia,
    } = setup(stream(mic));
    const camera = new FakeTrack("video");
    const first = new FakeTrack("video", "screen");
    const second = new FakeTrack("video", "screen");
    getUserMedia.mockResolvedValueOnce(stream(camera));
    getDisplayMedia
      .mockResolvedValueOnce(stream(first))
      .mockResolvedValueOnce(stream(second));
    await media.toggleCamera();
    await media.toggleSharing();
    await media.addSharing();
    expect(service.stream()?.getTracks()).toEqual([
      mic,
      camera,
      first,
      second,
    ]);
    expect(media.cameraOn()).toBe(true);
    expect(media.sharing()).toBe(true);
    expect(media.microphoneOn()).toBe(false);
    for (const track of [mic, camera, first, second])
      expect(track.stop).not.toHaveBeenCalled();
    await media.toggleSharing();
    expect(service.stream()?.getTracks()).toEqual([
      mic,
      camera,
    ]);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(second.stop).toHaveBeenCalledOnce();
    expect(mic.enabled).toBe(false);
    expect(camera.stop).not.toHaveBeenCalled();
    expect(media.cameraOn()).toBe(true);
    expect(media.sharing()).toBe(false);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("toggles the camera independently of two active screens", async () => {
    const camera = new FakeTrack("video");
    const first = new FakeTrack("video", "screen");
    const second = new FakeTrack("video", "screen");
    const { media, service, getUserMedia } = setup(
      stream(camera, first, second),
    );
    await media.toggleCamera();
    expect(service.stream()?.getVideoTracks()).toEqual([
      first,
      second,
    ]);
    expect(camera.stop).toHaveBeenCalledOnce();
    expect(media.cameraOn()).toBe(false);
    expect(media.sharing()).toBe(true);
    const nextCamera = new FakeTrack("video");
    getUserMedia.mockResolvedValueOnce(stream(nextCamera));
    await media.toggleCamera();
    expect(service.stream()?.getVideoTracks()).toEqual([
      first,
      second,
      nextCamera,
    ]);
    expect(first.stop).not.toHaveBeenCalled();
    expect(second.stop).not.toHaveBeenCalled();
    expect(media.cameraOn()).toBe(true);
  });

  it("closes only the requested screen and ignores unknown or audio IDs", () => {
    const mic = new FakeTrack("audio");
    const camera = new FakeTrack("video");
    const first = new FakeTrack("video", "screen");
    const second = new FakeTrack("video", "screen");
    const { media, service } = setup(
      stream(mic, camera, first, second),
    );
    media.stopVideoTrack(first.id);
    expect(service.stream()?.getTracks()).toEqual([
      mic,
      camera,
      second,
    ]);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(media.sharing()).toBe(true);
    const current = service.stream();
    media.stopVideoTrack("missing");
    media.stopVideoTrack(mic.id);
    expect(service.stream()).toBe(current);
    for (const track of [mic, camera, second])
      expect(track.stop).not.toHaveBeenCalled();
    media.stopVideoTrack(camera.id);
    expect(service.stream()?.getTracks()).toEqual([
      mic,
      second,
    ]);
    expect(media.cameraOn()).toBe(false);
    expect(media.sharing()).toBe(true);
  });

  it("browser stop-sharing removes only that source and never reacquires the camera", async () => {
    const camera = new FakeTrack("video");
    const first = new FakeTrack("video", "screen");
    const second = new FakeTrack("video", "screen");
    const { media, service, getUserMedia } = setup(
      stream(camera, first, second),
    );
    const before = service.stream();
    first.end();
    await flush();
    expect(service.stream()).not.toBe(before);
    expect(service.stream()?.getVideoTracks()).toEqual([
      camera,
      second,
    ]);
    expect(media.sharing()).toBe(true);
    expect(media.cameraOn()).toBe(true);
    second.end();
    await flush();
    expect(service.stream()?.getVideoTracks()).toEqual([
      camera,
    ]);
    expect(media.sharing()).toBe(false);
    expect(camera.stop).not.toHaveBeenCalled();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it("clears the snapshot after the last shared source ends", async () => {
    const screen = new FakeTrack("video", "screen");
    const { media, service } = setup(stream(screen));
    screen.end();
    await flush();
    expect(service.stream()).toBeNull();
    expect(media.sharing()).toBe(false);
    expect(media.cameraOn()).toBe(false);
  });

  it.each(["camera", "screen"] as const)(
    "combines concurrent camera and screen capture when %s resolves first",
    async (first) => {
      const {
        media,
        service,
        getUserMedia,
        getDisplayMedia,
      } = setup();
      const cameraRequest = deferred();
      const screenRequest = deferred();
      getUserMedia.mockReturnValueOnce(
        cameraRequest.promise,
      );
      getDisplayMedia.mockReturnValueOnce(
        screenRequest.promise,
      );
      const startCam = media.toggleCamera();
      const startScreen = media.addSharing();
      expect(media.cameraBusy()).toBe(true);
      expect(media.sharingBusy()).toBe(true);
      const camera = new FakeTrack("video");
      const screen = new FakeTrack("video", "screen");
      if (first === "camera") {
        cameraRequest.resolve(stream(camera));
        await startCam;
        expect(media.cameraBusy()).toBe(false);
        expect(media.sharingBusy()).toBe(true);
        screenRequest.resolve(stream(screen));
      } else {
        screenRequest.resolve(stream(screen));
        await startScreen;
        expect(media.sharingBusy()).toBe(false);
        expect(media.cameraBusy()).toBe(true);
        cameraRequest.resolve(stream(camera));
      }
      await Promise.all([startCam, startScreen]);
      expect(
        service.stream()?.getVideoTracks(),
      ).toHaveLength(2);
      expect(service.stream()?.getVideoTracks()).toEqual(
        expect.arrayContaining([camera, screen]),
      );
      expect(camera.stop).not.toHaveBeenCalled();
      expect(screen.stop).not.toHaveBeenCalled();
      expect(media.cameraOn()).toBe(true);
      expect(media.sharing()).toBe(true);
      expect(media.videoBusy()).toBe(false);
    },
  );

  it("combines concurrent microphone and camera capture without cloning retained sources", async () => {
    const { media, service, getUserMedia } = setup();
    const microphoneRequest = deferred();
    const cameraRequest = deferred();
    getUserMedia.mockImplementation((constraints) =>
      constraints.audio
        ? microphoneRequest.promise
        : cameraRequest.promise,
    );
    const startMic = media.toggleMicrophone();
    const startCam = media.toggleCamera();
    const mic = new FakeTrack("audio");
    const cam = new FakeTrack("video");
    microphoneRequest.resolve(stream(mic));
    await startMic;
    await media.toggleMicrophone();
    cameraRequest.resolve(stream(cam));
    await startCam;
    expect(service.stream()?.getTracks()).toEqual([
      mic,
      cam,
    ]);
    expect(mic.enabled).toBe(false);
    expect(mic.stop).not.toHaveBeenCalled();
    expect(cam.stop).not.toHaveBeenCalled();
    expect(media.microphoneOn()).toBe(false);
    expect(media.cameraOn()).toBe(true);
  });

  it("stopping all shares cancels a pending extra screen without canceling the camera", async () => {
    const currentScreen = new FakeTrack("video", "screen");
    const {
      media,
      service,
      getUserMedia,
      getDisplayMedia,
    } = setup(stream(currentScreen));
    const cameraRequest = deferred();
    const sharingRequest = deferred();
    getUserMedia.mockReturnValueOnce(cameraRequest.promise);
    getDisplayMedia.mockReturnValueOnce(
      sharingRequest.promise,
    );
    const cameraCapture = media.toggleCamera();
    const extraCapture = media.addSharing();
    await media.toggleSharing();
    expect(currentScreen.stop).toHaveBeenCalledOnce();
    expect(media.sharingBusy()).toBe(false);
    expect(media.cameraBusy()).toBe(true);
    const camera = new FakeTrack("video");
    const lateScreen = new FakeTrack("video", "screen");
    sharingRequest.resolve(stream(lateScreen));
    cameraRequest.resolve(stream(camera));
    await Promise.all([cameraCapture, extraCapture]);
    expect(lateScreen.stop).toHaveBeenCalledOnce();
    expect(service.stream()?.getVideoTracks()).toEqual([
      camera,
    ]);
    expect(camera.stop).not.toHaveBeenCalled();
  });

  it("does not resurrect media if capture resolves after leaving", async () => {
    const {
      media,
      service,
      getUserMedia,
      getDisplayMedia,
    } = setup();
    const cameraRequest = deferred();
    const sharingRequest = deferred();
    getUserMedia.mockReturnValueOnce(cameraRequest.promise);
    getDisplayMedia.mockReturnValueOnce(
      sharingRequest.promise,
    );
    const cameraCapture = media.toggleCamera();
    const screenCapture = media.addSharing();
    media.clear();
    const lateCamera = new FakeTrack("video");
    const lateScreen = new FakeTrack("video", "screen");
    cameraRequest.resolve(stream(lateCamera));
    sharingRequest.resolve(stream(lateScreen));
    await Promise.all([cameraCapture, screenCapture]);
    expect(lateCamera.stop).toHaveBeenCalledOnce();
    expect(lateScreen.stop).toHaveBeenCalledOnce();
    expect(service.stream()).toBeNull();
    expect(media.videoBusy()).toBe(false);
  });

  it("disposal discards pending captures but keeps every already-published source", async () => {
    const mic = new FakeTrack("audio");
    const camera = new FakeTrack("video");
    const screen = new FakeTrack("video", "screen");
    const current = stream(mic, camera, screen);
    const { media, service, getDisplayMedia } =
      setup(current);
    const pending = deferred();
    getDisplayMedia.mockReturnValueOnce(pending.promise);
    const request = media.addSharing();
    media.dispose();
    const lateScreen = new FakeTrack("video", "screen");
    const lateAudio = new FakeTrack("audio");
    pending.resolve(stream(lateScreen, lateAudio));
    await request;
    expect(lateScreen.stop).toHaveBeenCalledOnce();
    expect(lateAudio.stop).toHaveBeenCalledOnce();
    expect(service.stream()).toBe(current);
    for (const track of [mic, camera, screen])
      expect(track.stop).not.toHaveBeenCalled();
    screen.end();
    expect(service.stream()?.getTracks()).toEqual([
      mic,
      camera,
    ]);
  });

  it("rejected screen permission preserves the active camera and microphone", async () => {
    const camera = new FakeTrack("video");
    const mic = new FakeTrack("audio");
    const current = stream(camera, mic);
    const { media, service, getDisplayMedia } =
      setup(current);
    getDisplayMedia.mockRejectedValueOnce(
      new Error("Permission denied"),
    );
    await media.addSharing();
    expect(service.stream()).toBe(current);
    expect(camera.stop).not.toHaveBeenCalled();
    expect(mic.stop).not.toHaveBeenCalled();
    expect(media.error()).toBe("Permission denied");
    expect(media.videoBusy()).toBe(false);
  });

  it("camera rejection cannot cancel another in-flight screen capture", async () => {
    const screen = new FakeTrack("video", "screen");
    const {
      media,
      service,
      getUserMedia,
      getDisplayMedia,
    } = setup(stream(screen));
    const cameraRequest = deferred();
    const sharingRequest = deferred();
    getUserMedia.mockReturnValueOnce(cameraRequest.promise);
    getDisplayMedia.mockReturnValueOnce(
      sharingRequest.promise,
    );
    const cameraCapture = media.toggleCamera();
    const extraCapture = media.addSharing();
    cameraRequest.reject(new Error("Camera disconnected"));
    await cameraCapture;
    expect(media.sharingBusy()).toBe(true);
    const extra = new FakeTrack("video", "screen");
    sharingRequest.resolve(stream(extra));
    await extraCapture;
    expect(service.stream()?.getVideoTracks()).toEqual([
      screen,
      extra,
    ]);
    expect(screen.stop).not.toHaveBeenCalled();
    expect(media.cameraOn()).toBe(false);
    expect(media.sharing()).toBe(true);
    expect(media.error()).toBe("Camera disconnected");
  });

  it("keeps capture source identity across route remounts even without displaySurface support", async () => {
    const camera = new FakeTrack("video");
    const screenWithoutSettings = new FakeTrack("video");
    const screenAudio = new FakeTrack("audio");
    const {
      media,
      service,
      getUserMedia,
      getDisplayMedia,
    } = setup(stream(camera));
    getDisplayMedia.mockResolvedValueOnce(
      stream(screenWithoutSettings, screenAudio),
    );
    await media.addSharing();
    expect(
      getMeetingVideoSourceKind(
        asTrack(screenWithoutSettings),
      ),
    ).toBe("screen");
    expect(getMeetingVideoSourceKind(asTrack(camera))).toBe(
      "camera",
    );
    media.dispose();
    let reopened!: ReturnType<
      typeof createMeetingMediaController
    >;
    createRoot((dispose) => {
      reopened = createMeetingMediaController({
        stream: service.stream,
        replace: service.replace,
        clear: service.clear,
        getUserMedia,
        getDisplayMedia,
      });
      createEffect(reopened.sync);
      cleanups.push(() => {
        reopened.dispose();
        dispose();
      });
    });
    expect(reopened.cameraOn()).toBe(true);
    expect(reopened.sharing()).toBe(true);
    expect(reopened.microphoneOn()).toBe(false);
    screenWithoutSettings.end();
    await flush();
    expect(reopened.cameraOn()).toBe(true);
    expect(reopened.sharing()).toBe(false);
    expect(service.stream()?.getVideoTracks()).toEqual([
      camera,
    ]);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(screenAudio.stop).toHaveBeenCalledOnce();
  });

  it("publishes display audio and releases only unused capture tracks", async () => {
    const mic = new FakeTrack("audio");
    const { media, service, getDisplayMedia } = setup(
      stream(mic),
    );
    const video = new FakeTrack("video", "screen");
    const systemAudio = new FakeTrack("audio");
    const unusedVideo = new FakeTrack("video");
    getDisplayMedia.mockResolvedValueOnce(
      stream(video, systemAudio, unusedVideo),
    );
    await media.addSharing();
    expect(service.stream()?.getTracks()).toEqual([
      mic,
      video,
      systemAudio,
    ]);
    expect(systemAudio.contentHint).toBe("music");
    expect(
      getMeetingAudioSource(asTrack(systemAudio)),
    ).toEqual({ kind: "screen", videoTrack: video });
    createRoot((dispose) => {
      const sources = createMeetingSources(() => [
        {
          id: "me",
          name: "Me",
          local: true,
          stream: service.stream(),
        },
      ]);
      expect(
        sources().map((source) =>
          source.stream?.getTracks(),
        ),
      ).toEqual([[mic], [video, systemAudio]]);
      dispose();
    });
    expect(systemAudio.stop).not.toHaveBeenCalled();
    expect(unusedVideo.stop).toHaveBeenCalledOnce();
    expect(mic.stop).not.toHaveBeenCalled();
  });

  it("keeps shared audio independent of microphone capture, mute and device changes", async () => {
    const f = setup();
    const video = new FakeTrack("video", "screen");
    const audio = new FakeTrack("audio");
    f.getDisplayMedia.mockResolvedValueOnce(
      stream(video, audio),
    );
    await f.media.addSharing();
    // Source ownership, not a mutable encoding hint, distinguishes shared audio.
    audio.contentHint = "";
    f.media.sync();
    expect(f.media.microphoneOn()).toBe(false);
    const mic = new FakeTrack("audio");
    f.getUserMedia.mockResolvedValueOnce(stream(mic));
    await f.media.toggleMicrophone();
    expect(f.getUserMedia).toHaveBeenCalledOnce();
    await f.media.toggleMicrophone();
    expect(mic.enabled).toBe(false);
    expect(audio.enabled).toBe(true);
    const replacement = new FakeTrack("audio");
    f.getUserMedia.mockResolvedValueOnce(
      stream(replacement),
    );
    await f.media.selectMicrophone("mic-2");
    expect(f.service.stream()?.getTracks()).toEqual([
      video,
      audio,
      replacement,
    ]);
    expect(replacement.enabled).toBe(false);
    expect(audio.enabled).toBe(true);
    expect(audio.stop).not.toHaveBeenCalled();
    f.media.clear();
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(video.stop).toHaveBeenCalledOnce();
  });

  it("mutes and resumes all display audio without replacing tracks or changing microphone and video", async () => {
    const mic = new FakeTrack("audio");
    const camera = new FakeTrack("video");
    const first = new FakeTrack("video", "screen");
    const firstAudio = new FakeTrack("audio");
    const second = new FakeTrack("video", "screen");
    const secondAudio = new FakeTrack("audio");
    const f = setup(stream(mic, camera));
    f.getDisplayMedia
      .mockResolvedValueOnce(stream(first, firstAudio))
      .mockResolvedValueOnce(stream(second, secondAudio));
    await f.media.addSharing();
    await f.media.addSharing();
    const current = f.service.stream();
    expect(f.media.sharingAudioAvailable()).toBe(true);
    expect(f.media.sharingAudioOn()).toBe(true);
    // Ownership survives mutable encoding hints.
    firstAudio.contentHint = "";
    f.media.setSharingAudioEnabled(false);
    expect(f.media.sharingAudioOn()).toBe(false);
    expect(f.media.sharingAudioAvailable()).toBe(true);
    expect(firstAudio.enabled).toBe(false);
    expect(secondAudio.enabled).toBe(false);
    expect(f.media.microphoneOn()).toBe(true);
    expect(mic.enabled).toBe(true);
    await f.media.toggleMicrophone();
    f.media.setSharingAudioEnabled(true);
    expect(f.media.sharingAudioOn()).toBe(true);
    expect(firstAudio.enabled).toBe(true);
    expect(secondAudio.enabled).toBe(true);
    expect(mic.enabled).toBe(false);
    expect(f.service.stream()).toBe(current);
    for (const video of [camera, first, second])
      expect(video.enabled).toBe(true);
    for (const track of [
      mic,
      camera,
      first,
      firstAudio,
      second,
      secondAudio,
    ])
      expect(track.stop).not.toHaveBeenCalled();
    expect(f.getDisplayMedia).toHaveBeenCalledTimes(2);
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it("keeps additional displays muted until all sharing stops", async () => {
    const f = setup();
    const first = new FakeTrack("video", "screen");
    const firstAudio = new FakeTrack("audio");
    const second = new FakeTrack("video", "screen");
    const secondAudio = new FakeTrack("audio");
    const next = new FakeTrack("video", "screen");
    const nextAudio = new FakeTrack("audio");
    f.getDisplayMedia
      .mockResolvedValueOnce(stream(first, firstAudio))
      .mockResolvedValueOnce(stream(second, secondAudio))
      .mockResolvedValueOnce(stream(next, nextAudio));
    await f.media.addSharing();
    f.media.setSharingAudioEnabled(false);
    await f.media.addSharing();
    expect(secondAudio.enabled).toBe(false);
    expect(f.media.sharingAudioOn()).toBe(false);
    await f.media.toggleSharing();
    expect(f.media.sharingAudioAvailable()).toBe(false);
    expect(f.media.sharingAudioOn()).toBe(false);
    await f.media.addSharing();
    expect(nextAudio.enabled).toBe(true);
    expect(f.media.sharingAudioOn()).toBe(true);
  });

  it("does not acquire audio when the current share has none", async () => {
    const mic = new FakeTrack("audio");
    const video = new FakeTrack("video", "screen");
    const f = setup(stream(mic, video));
    f.media.setSharingAudioEnabled(true);
    expect(f.media.sharingAudioAvailable()).toBe(false);
    expect(f.media.sharingAudioOn()).toBe(false);
    expect(mic.enabled).toBe(true);
    expect(video.enabled).toBe(true);
    expect(f.getDisplayMedia).not.toHaveBeenCalled();
    expect(f.getUserMedia).not.toHaveBeenCalled();
  });

  it.each(["tile", "browser", "all"])(
    "stops the matching display audio when sharing ends via %s",
    async (method) => {
      const mic = new FakeTrack("audio");
      const camera = new FakeTrack("video");
      const f = setup(stream(mic, camera));
      const first = new FakeTrack("video", "screen");
      const firstAudio = new FakeTrack("audio");
      const second = new FakeTrack("video", "screen");
      const secondAudio = new FakeTrack("audio");
      f.getDisplayMedia
        .mockResolvedValueOnce(stream(first, firstAudio))
        .mockResolvedValueOnce(stream(second, secondAudio));
      await f.media.addSharing();
      await f.media.addSharing();
      if (method === "tile")
        f.media.stopVideoTrack(first.id);
      else if (method === "browser") first.end();
      else await f.media.toggleSharing();
      expect(firstAudio.stop).toHaveBeenCalledOnce();
      expect(f.service.stream()?.getTracks()).toEqual(
        method === "all"
          ? [mic, camera]
          : [mic, camera, second, secondAudio],
      );
      if (method !== "all") {
        expect(secondAudio.stop).not.toHaveBeenCalled();
        f.media.stopVideoTrack(second.id);
      }
      expect(secondAudio.stop).toHaveBeenCalledOnce();
      expect(mic.stop).not.toHaveBeenCalled();
      expect(camera.stop).not.toHaveBeenCalled();
    },
  );

  it("retains the display when only its audio ends", async () => {
    const f = setup();
    const video = new FakeTrack("video", "screen");
    const audio = new FakeTrack("audio");
    f.getDisplayMedia.mockResolvedValueOnce(
      stream(video, audio),
    );
    await f.media.addSharing();
    audio.end();
    expect(f.service.stream()?.getTracks()).toEqual([
      video,
    ]);
    expect(video.stop).not.toHaveBeenCalled();
    expect(f.media.sharing()).toBe(true);
    expect(f.media.microphoneOn()).toBe(false);
    expect(f.media.sharingAudioAvailable()).toBe(false);
    expect(f.media.sharingAudioOn()).toBe(false);
  });

  it("releases audio if capture returns no live display", async () => {
    const mic = new FakeTrack("audio");
    const f = setup(stream(mic));
    const audio = new FakeTrack("audio");
    f.getDisplayMedia.mockResolvedValueOnce(stream(audio));
    await f.media.addSharing();
    expect(audio.stop).toHaveBeenCalledOnce();
    expect(f.service.stream()?.getTracks()).toEqual([mic]);
    expect(f.media.error()).toBe(
      "No screen track was provided",
    );
  });
});

describe("meeting media device selection", () => {
  it("defers settings preferences until toolbar activation without changing active sources", async () => {
    const microphone = new FakeTrack(
      "audio",
      "microphone",
      "mic-old",
    );
    const camera = new FakeTrack(
      "video",
      "camera",
      "cam-old",
    );
    const screen = new FakeTrack("video", "screen");
    const initial = stream(microphone, camera, screen);
    const f = setup(initial);
    f.media.setMicrophonePreference("mic-new");
    f.media.setCameraPreference("cam-new");
    f.media.sync();
    expect(f.service.stream()).toBe(initial);
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(f.getDisplayMedia).not.toHaveBeenCalled();
    for (const track of [microphone, camera, screen]) {
      expect(track.enabled).toBe(true);
      expect(track.stop).not.toHaveBeenCalled();
    }

    // A separate source update must not overwrite unapplied preferences.
    const extraScreen = new FakeTrack("video", "screen");
    f.getDisplayMedia.mockResolvedValueOnce(
      stream(extraScreen),
    );
    await f.media.addSharing();
    f.media.sync();
    expect(f.media.selectedMicrophoneId()).toBe("mic-new");
    expect(f.media.selectedCameraId()).toBe("cam-new");
    await f.media.toggleMicrophone();
    await f.media.toggleCamera();
    expect(f.getUserMedia).not.toHaveBeenCalled();
    expect(microphone.enabled).toBe(false);
    const nextMic = new FakeTrack("audio");
    const nextCamera = new FakeTrack("video");
    f.getUserMedia.mockImplementation(
      async (constraints) =>
        constraints.audio
          ? stream(nextMic)
          : stream(nextCamera),
    );
    await f.media.toggleMicrophone();
    await f.media.toggleCamera();
    expect(f.getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "mic-new" } },
      video: false,
    });
    expect(f.getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { deviceId: { exact: "cam-new" } },
    });
    expect(f.service.stream()?.getTracks()).toEqual([
      screen,
      extraScreen,
      nextMic,
      nextCamera,
    ]);
    expect(microphone.stop).toHaveBeenCalledOnce();
    expect(camera.stop).toHaveBeenCalledOnce();
    expect(screen.stop).not.toHaveBeenCalled();
    expect(extraScreen.stop).not.toHaveBeenCalled();
  });

  it("keeps a muted microphone and its configured preference when activation fails, then retries that device", async () => {
    const old = new FakeTrack(
      "audio",
      "microphone",
      "mic-old",
    );
    old.enabled = false;
    const f = setup(stream(old));
    f.media.setMicrophonePreference("mic-new");
    expect(f.getUserMedia).not.toHaveBeenCalled();
    f.getUserMedia.mockRejectedValueOnce(
      new Error("Unavailable"),
    );
    await f.media.toggleMicrophone();
    f.media.sync();
    expect(old.enabled).toBe(false);
    expect(old.stop).not.toHaveBeenCalled();
    expect(f.media.microphoneOn()).toBe(false);
    expect(f.media.selectedMicrophoneId()).toBe("mic-new");
    const next = new FakeTrack("audio");
    f.getUserMedia.mockResolvedValueOnce(stream(next));
    await f.media.toggleMicrophone();
    expect(f.getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { exact: "mic-new" } },
      video: false,
    });
    expect(next.enabled).toBe(true);
    expect(f.media.microphoneOn()).toBe(true);
    expect(old.stop).toHaveBeenCalledOnce();
  });

  it.each(["microphone", "camera"] as const)(
    "discards a pending %s switch after a settings preference changes without replacing the live source",
    async (kind) => {
      const old = new FakeTrack(
        kind === "microphone" ? "audio" : "video",
        kind,
        "old",
      );
      const initial = stream(old);
      const f = setup(initial);
      const select =
        kind === "microphone"
          ? f.media.selectMicrophone
          : f.media.selectCamera;
      const prefer =
        kind === "microphone"
          ? f.media.setMicrophonePreference
          : f.media.setCameraPreference;
      const selected =
        kind === "microphone"
          ? f.media.selectedMicrophoneId
          : f.media.selectedCameraId;
      const busy =
        kind === "microphone"
          ? f.media.microphoneBusy
          : f.media.cameraBusy;
      const pending = deferred();
      f.getUserMedia.mockReturnValueOnce(pending.promise);
      const switching = select("pending");
      prefer("preferred");
      expect(busy()).toBe(false);
      expect(f.getUserMedia).toHaveBeenCalledOnce();
      const late = new FakeTrack(old.kind);
      pending.resolve(stream(late));
      await switching;
      f.media.sync();
      expect(selected()).toBe("preferred");
      expect(late.stop).toHaveBeenCalledOnce();
      expect(old.stop).not.toHaveBeenCalled();
      expect(f.service.stream()).toBe(initial);

      // An explicit toolbar switch must compare the live source, even when
      // its dropdown already reflects the unapplied settings preference.
      const next = new FakeTrack(old.kind);
      f.getUserMedia.mockResolvedValueOnce(stream(next));
      await select("preferred");
      expect(f.getUserMedia).toHaveBeenCalledTimes(2);
      expect(f.service.stream()?.getTracks()).toEqual([
        next,
      ]);
      expect(old.stop).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["default", ""],
    ["communications", "communications"],
  ])(
    "initializes browser device alias %s as %s without recapturing",
    (deviceId, expected) => {
      const microphone = new FakeTrack(
        "audio",
        "microphone",
        deviceId,
      );
      const camera = new FakeTrack(
        "video",
        "camera",
        deviceId,
      );
      const { media, getUserMedia } = setup(
        stream(microphone, camera),
      );
      expect(media.selectedMicrophoneId()).toBe(expected);
      expect(media.selectedCameraId()).toBe(expected);
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(microphone.stop).not.toHaveBeenCalled();
      expect(camera.stop).not.toHaveBeenCalled();
    },
  );
  it("stores preferences while off and uses exact device constraints when capture is enabled", async () => {
    const screen = new FakeTrack("video", "screen");
    const { media, service, getUserMedia } = setup(
      stream(screen),
    );
    await media.selectMicrophone("mic-usb");
    await media.selectCamera("camera-usb");
    expect(media.selectedMicrophoneId()).toBe("mic-usb");
    expect(media.selectedCameraId()).toBe("camera-usb");
    expect(getUserMedia).not.toHaveBeenCalled();
    const mic = new FakeTrack("audio");
    const camera = new FakeTrack("video");
    getUserMedia.mockImplementation(async (constraints) =>
      constraints.audio ? stream(mic) : stream(camera),
    );
    await Promise.all([
      media.toggleMicrophone(),
      media.toggleCamera(),
    ]);
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { deviceId: { exact: "mic-usb" } },
      video: false,
    });
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: { deviceId: { exact: "camera-usb" } },
    });
    expect(service.stream()?.getTracks()).toEqual([
      screen,
      mic,
      camera,
    ]);
    expect(screen.stop).not.toHaveBeenCalled();
  });

  it("commits a live microphone switch only after success and keeps microphone mute plus every video source", async () => {
    const oldMic = new FakeTrack(
      "audio",
      "microphone",
      "mic-old",
    );
    oldMic.enabled = false;
    const camera = new FakeTrack("video");
    const first = new FakeTrack("video", "screen");
    const second = new FakeTrack("video", "screen");
    const initial = stream(oldMic, camera, first, second);
    const { media, service, getUserMedia } = setup(initial);
    const pending = deferred();
    getUserMedia.mockReturnValueOnce(pending.promise);
    const switching = media.selectMicrophone("mic-new");
    expect(media.microphoneBusy()).toBe(true);
    expect(media.selectedMicrophoneId()).toBe("mic-old");
    expect(service.stream()).toBe(initial);
    expect(oldMic.stop).not.toHaveBeenCalled();
    const nextMic = new FakeTrack(
      "audio",
      "microphone",
      "mic-new",
    );
    pending.resolve(stream(nextMic));
    await switching;
    expect(media.selectedMicrophoneId()).toBe("mic-new");
    expect(media.microphoneBusy()).toBe(false);
    expect(media.microphoneOn()).toBe(false);
    expect(nextMic.enabled).toBe(false);
    expect(service.stream()?.getTracks()).toEqual([
      camera,
      first,
      second,
      nextMic,
    ]);
    expect(oldMic.stop).toHaveBeenCalledOnce();
    for (const track of [camera, first, second, nextMic])
      expect(track.stop).not.toHaveBeenCalled();
    await media.toggleMicrophone();
    expect(nextMic.enabled).toBe(true);
    expect(getUserMedia).toHaveBeenCalledOnce();
  });

  it("retains the old camera on a failed switch and uses the selected camera again after turning it off", async () => {
    const oldCamera = new FakeTrack(
      "video",
      "camera",
      "camera-old",
    );
    const mic = new FakeTrack("audio");
    mic.enabled = false;
    const screen = new FakeTrack("video", "screen");
    const initial = stream(mic, oldCamera, screen);
    const { media, service, getUserMedia } = setup(initial);
    getUserMedia.mockRejectedValueOnce(
      new Error("Camera unavailable"),
    );
    await media.selectCamera("camera-new");
    expect(service.stream()).toBe(initial);
    expect(oldCamera.stop).not.toHaveBeenCalled();
    expect(media.selectedCameraId()).toBe("camera-old");
    expect(media.error()).toBe("Camera unavailable");
    const nextCamera = new FakeTrack("video");
    getUserMedia.mockResolvedValueOnce(stream(nextCamera));
    await media.selectCamera("camera-new");
    expect(service.stream()?.getTracks()).toEqual([
      mic,
      screen,
      nextCamera,
    ]);
    expect(media.selectedCameraId()).toBe("camera-new");
    expect(media.error()).toBeNull();
    expect(mic.enabled).toBe(false);
    expect(screen.stop).not.toHaveBeenCalled();
    await media.toggleCamera();
    getUserMedia.mockResolvedValueOnce(
      stream(new FakeTrack("video")),
    );
    await media.toggleCamera();
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: false,
      video: { deviceId: { exact: "camera-new" } },
    });
  });

  it("leaves an existing microphone working when permission or valid audio capture is unavailable", async () => {
    const mic = new FakeTrack("audio", "microphone", "old");
    const { media, service, getUserMedia } = setup(
      stream(mic),
    );
    getUserMedia.mockRejectedValueOnce(
      new Error("Permission denied"),
    );
    await media.selectMicrophone("new");
    expect(media.selectedMicrophoneId()).toBe("old");
    expect(media.microphoneOn()).toBe(true);
    expect(media.error()).toBe("Permission denied");
    const wrongKind = new FakeTrack("video");
    getUserMedia.mockResolvedValueOnce(stream(wrongKind));
    await media.selectMicrophone("new");
    expect(media.error()).toBe(
      "No microphone track was provided",
    );
    expect(media.selectedMicrophoneId()).toBe("old");
    expect(service.stream()?.getAudioTracks()).toEqual([
      mic,
    ]);
    expect(mic.stop).not.toHaveBeenCalled();
    expect(wrongKind.stop).toHaveBeenCalledOnce();
  });

  it.each(["microphone", "camera"] as const)(
    "keeps the newest %s selection when an older request resolves later",
    async (kind) => {
      const old = new FakeTrack(
        kind === "camera" ? "video" : "audio",
        kind,
        "old",
      );
      const { media, service, getUserMedia } = setup(
        stream(old),
      );
      const first = deferred();
      const second = deferred();
      getUserMedia
        .mockReturnValueOnce(first.promise)
        .mockReturnValueOnce(second.promise);
      const select =
        kind === "camera"
          ? media.selectCamera
          : media.selectMicrophone;
      const selected =
        kind === "camera"
          ? media.selectedCameraId
          : media.selectedMicrophoneId;
      const firstSwitch = select("first");
      const secondSwitch = select("second");
      const next = new FakeTrack(old.kind);
      second.resolve(stream(next));
      await secondSwitch;
      const late = new FakeTrack(old.kind);
      first.resolve(stream(late));
      await firstSwitch;
      expect(selected()).toBe("second");
      expect(service.stream()?.getTracks()).toEqual([next]);
      expect(next.stop).not.toHaveBeenCalled();
      expect(late.stop).toHaveBeenCalledOnce();
      expect(old.stop).toHaveBeenCalledOnce();
    },
  );

  it.each(["clear", "dispose"] as const)(
    "discards both pending device switches after %s",
    async (method) => {
      const mic = new FakeTrack(
        "audio",
        "microphone",
        "old-mic",
      );
      const camera = new FakeTrack(
        "video",
        "camera",
        "old-camera",
      );
      const initial = stream(mic, camera);
      const { media, service, getUserMedia } =
        setup(initial);
      const microphoneRequest = deferred();
      const cameraRequest = deferred();
      getUserMedia.mockImplementation((constraints) =>
        constraints.audio
          ? microphoneRequest.promise
          : cameraRequest.promise,
      );
      const microphoneSwitch =
        media.selectMicrophone("new-mic");
      const cameraSwitch = media.selectCamera("new-camera");
      media[method]();
      const nextMic = new FakeTrack("audio");
      const nextCamera = new FakeTrack("video");
      microphoneRequest.resolve(stream(nextMic));
      cameraRequest.resolve(stream(nextCamera));
      await Promise.all([microphoneSwitch, cameraSwitch]);
      expect(nextMic.stop).toHaveBeenCalledOnce();
      expect(nextCamera.stop).toHaveBeenCalledOnce();
      expect(media.selectedMicrophoneId()).toBe("old-mic");
      expect(media.selectedCameraId()).toBe("old-camera");
      expect(media.microphoneBusy()).toBe(false);
      expect(media.cameraBusy()).toBe(false);
      expect(service.stream()).toBe(
        method === "clear" ? null : initial,
      );
      if (method === "dispose") {
        expect(mic.stop).not.toHaveBeenCalled();
        expect(camera.stop).not.toHaveBeenCalled();
      }
    },
  );

  it("does not resurrect the camera after its tile is closed during a device switch", async () => {
    const camera = new FakeTrack(
      "video",
      "camera",
      "old-camera",
    );
    const screen = new FakeTrack("video", "screen");
    const { media, service, getUserMedia } = setup(
      stream(camera, screen),
    );
    const pending = deferred();
    getUserMedia.mockReturnValueOnce(pending.promise);
    const switching = media.selectCamera("new-camera");
    media.stopVideoTrack(camera.id);
    const next = new FakeTrack("video");
    pending.resolve(stream(next));
    await switching;
    expect(service.stream()?.getVideoTracks()).toEqual([
      screen,
    ]);
    expect(media.cameraOn()).toBe(false);
    expect(media.selectedCameraId()).toBe("old-camera");
    expect(next.stop).toHaveBeenCalledOnce();
    expect(screen.stop).not.toHaveBeenCalled();
  });

  it("updates only preferences and cancels older capture when a device is chosen before initial capture finishes", async () => {
    const { media, service, getUserMedia } = setup();
    const pending = deferred();
    getUserMedia.mockReturnValueOnce(pending.promise);
    const opening = media.toggleCamera();
    await media.selectCamera("preferred");
    expect(getUserMedia).toHaveBeenCalledOnce();
    const late = new FakeTrack("video");
    pending.resolve(stream(late));
    await opening;
    expect(service.stream()).toBeNull();
    expect(media.selectedCameraId()).toBe("preferred");
    expect(late.stop).toHaveBeenCalledOnce();
  });

  it("restores system-default intent on remount even though capture exposes a concrete hardware device ID", async () => {
    const camera = new FakeTrack(
      "video",
      "camera",
      "explicit-old",
    );
    const {
      media,
      service,
      getUserMedia,
      getDisplayMedia,
    } = setup(stream(camera));
    const systemDefault = new FakeTrack(
      "video",
      "camera",
      "actual-default-camera",
    );
    getUserMedia.mockResolvedValueOnce(
      stream(systemDefault),
    );
    await media.selectCamera("");
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: false,
      video: true,
    });
    expect(media.selectedCameraId()).toBe("");
    media.dispose();
    const reopened = createMeetingMediaController({
      stream: service.stream,
      replace: service.replace,
      clear: service.clear,
      getUserMedia,
      getDisplayMedia,
    });
    cleanups.push(reopened.dispose);
    expect(reopened.selectedCameraId()).toBe("");
    expect(reopened.cameraOn()).toBe(true);
    expect(systemDefault.stop).not.toHaveBeenCalled();
  });
});
