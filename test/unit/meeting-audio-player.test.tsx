// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { reconcile } from "solid-js/store";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  AudioPlayerProvider,
  useAudioPlayer,
} from "@/routes/home/components/audio-player";
import {
  setAppState,
  type ClientInfo,
} from "@/libs/state/app-state";

vi.mock("@/libs/state/app-state", async () => {
  const { createStore } = await import("solid-js/store");
  const [appState, setAppState] = createStore({
    session: { clientViewData: {} },
  });
  return { appState, setAppState };
});
let nextTrackId = 0;
class Track extends EventTarget {
  id = `audio-${++nextTrackId}`;
  kind = "audio";
  readyState = "live";
  enabled = true;
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}
class Stream extends EventTarget {
  constructor(readonly tracks: MediaStreamTrack[] = []) {
    super();
  }
  getAudioTracks() {
    return this.tracks.filter(
      (track) => track.kind === "audio",
    );
  }
  add(track: MediaStreamTrack) {
    this.tracks.push(track);
    this.dispatchEvent(new Event("addtrack"));
  }
}
const track = () =>
  new Track() as unknown as MediaStreamTrack;
const connect = (stream: Stream) =>
  setAppState("session", "clientViewData", {
    alice: {
      clientId: "alice",
      name: "Alice",
      stream: stream as unknown as MediaStream,
    } as ClientInfo,
  });
const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};
const originalSinkDescriptor =
  Object.getOwnPropertyDescriptor(
    HTMLMediaElement.prototype,
    "setSinkId",
  );
const installSink = (
  implementation:
    | ((id: string) => Promise<void>)
    | undefined,
) => {
  Object.defineProperty(
    HTMLMediaElement.prototype,
    "setSinkId",
    {
      configurable: true,
      writable: true,
      value: implementation,
    },
  );
};
const deferred = () => {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((success, failure) => {
    resolve = success;
    reject = failure;
  });
  return { promise, resolve, reject };
};
let player!: ReturnType<typeof useAudioPlayer>;
function Consumer() {
  player = useAudioPlayer();
  return <span />;
}
function setup() {
  return render(() => (
    <AudioPlayerProvider>
      <Consumer />
    </AudioPlayerProvider>
  ));
}
beforeEach(() => {
  installSink(undefined);
  vi.stubGlobal("MediaStream", Stream);
  setAppState("session", "clientViewData", reconcile({}));
  vi.spyOn(
    HTMLMediaElement.prototype,
    "play",
  ).mockResolvedValue();
  vi.spyOn(
    HTMLMediaElement.prototype,
    "pause",
  ).mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (originalSinkDescriptor)
    Object.defineProperty(
      HTMLMediaElement.prototype,
      "setSinkId",
      originalSinkDescriptor,
    );
  else
    Reflect.deleteProperty(
      HTMLMediaElement.prototype,
      "setSinkId",
    );
});

describe("meeting audio output selection", () => {
  it("selects output without audio and keeps it for later tracks and reconnects", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    installSink(sink);
    const view = setup();
    const audio = view.container.querySelector("audio")!;
    expect(player.outputSupported()).toBe(true);
    expect(player.outputDeviceId()).toBe("");
    expect(player.outputBusy()).toBe(false);
    expect(player.hasAudio()).toBe(false);
    const operation = player.setOutputDevice("speaker-2");
    expect(player.outputBusy()).toBe(true);
    expect(player.outputDeviceId()).toBe("");
    await operation;
    expect(sink).toHaveBeenCalledWith("speaker-2");
    expect(sink.mock.contexts[0]).toBe(audio);
    expect(player.outputDeviceId()).toBe("speaker-2");
    expect(player.outputBusy()).toBe(false);
    connect(new Stream([track()]));
    await flush();
    connect(new Stream([track()]));
    await flush();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(player.outputDeviceId()).toBe("speaker-2");
    expect(player.playState()).toBe(true);
    await player.setOutputDevice("");
    expect(sink).toHaveBeenLastCalledWith("");
    expect(player.outputDeviceId()).toBe("");
  });

  it("preserves playback and global mute while switching output", async () => {
    const sink = vi.fn().mockResolvedValue(undefined);
    installSink(sink);
    connect(new Stream([track()]));
    setup();
    await flush();
    const plays = vi.mocked(HTMLMediaElement.prototype.play)
      .mock.calls.length;
    const pauses = vi.mocked(
      HTMLMediaElement.prototype.pause,
    ).mock.calls.length;
    await player.setOutputDevice("speaker-1");
    expect(player.playState()).toBe(true);
    expect(
      HTMLMediaElement.prototype.play,
    ).toHaveBeenCalledTimes(plays);
    expect(
      HTMLMediaElement.prototype.pause,
    ).toHaveBeenCalledTimes(pauses);
    player.setPlay(false);
    const mutedPauses = vi.mocked(
      HTMLMediaElement.prototype.pause,
    ).mock.calls.length;
    await player.setOutputDevice("speaker-2");
    expect(player.playState()).toBe(false);
    expect(
      HTMLMediaElement.prototype.play,
    ).toHaveBeenCalledTimes(plays);
    expect(
      HTMLMediaElement.prototype.pause,
    ).toHaveBeenCalledTimes(mutedPauses);
    connect(new Stream([track()]));
    await flush();
    expect(player.playState()).toBe(false);
    expect(player.outputDeviceId()).toBe("speaker-2");
  });

  it("keeps the previous selection on failure and allows a later request", async () => {
    const denied = new DOMException(
      "permission denied",
      "NotAllowedError",
    );
    const sink = vi
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(denied)
      .mockResolvedValue(undefined);
    installSink(sink);
    setup();
    await player.setOutputDevice("speaker-1");
    await expect(
      player.setOutputDevice("denied"),
    ).rejects.toBe(denied);
    expect(player.outputDeviceId()).toBe("speaker-1");
    expect(player.outputBusy()).toBe(false);
    await player.setOutputDevice("speaker-2");
    expect(player.outputDeviceId()).toBe("speaker-2");
  });

  it("serializes rapid selections and stays busy until every request settles", async () => {
    const first = deferred(),
      second = deferred();
    const sink = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    installSink(sink);
    setup();
    const firstOperation =
      player.setOutputDevice("speaker-1");
    const secondOperation =
      player.setOutputDevice("speaker-2");
    await flush();
    expect(sink).toHaveBeenCalledTimes(1);
    expect(player.outputDeviceId()).toBe("");
    first.resolve();
    await firstOperation;
    await flush();
    expect(sink).toHaveBeenCalledTimes(2);
    expect(sink).toHaveBeenLastCalledWith("speaker-2");
    expect(player.outputDeviceId()).toBe("speaker-1");
    expect(player.outputBusy()).toBe(true);
    second.resolve();
    await secondOperation;
    expect(player.outputDeviceId()).toBe("speaker-2");
    expect(player.outputBusy()).toBe(false);
  });

  it("continues queued selections when an earlier request rejects", async () => {
    const first = deferred();
    const denied = new DOMException(
      "not found",
      "NotFoundError",
    );
    const sink = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValue(undefined);
    installSink(sink);
    setup();
    const failed = player
      .setOutputDevice("removed")
      .catch((error) => error);
    const succeeding = player.setOutputDevice("available");
    await flush();
    first.reject(denied);
    expect(await failed).toBe(denied);
    await succeeding;
    expect(sink.mock.calls.map(([id]) => id)).toEqual([
      "removed",
      "available",
    ]);
    expect(player.outputDeviceId()).toBe("available");
    expect(player.outputBusy()).toBe(false);
  });

  it("only accepts the system default when setSinkId is unavailable", async () => {
    setup();
    expect(player.outputSupported()).toBe(false);
    await player.setOutputDevice("");
    await expect(
      player.setOutputDevice("speaker-1"),
    ).rejects.toMatchObject({ name: "NotSupportedError" });
    expect(player.outputDeviceId()).toBe("");
    expect(player.outputBusy()).toBe(false);
  });

  it("ignores late native completion and cancels queued requests after unmount", async () => {
    const first = deferred();
    const sink = vi
      .fn()
      .mockImplementation(() => first.promise);
    installSink(sink);
    const view = setup();
    const pending = player
      .setOutputDevice("speaker-1")
      .catch((error) => error);
    const queued = player
      .setOutputDevice("speaker-2")
      .catch((error) => error);
    await flush();
    expect(sink).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(player.outputBusy()).toBe(false);
    first.resolve();
    expect(await pending).toMatchObject({
      name: "AbortError",
    });
    expect(await queued).toMatchObject({
      name: "AbortError",
    });
    expect(player.outputDeviceId()).toBe("");
    expect(player.outputBusy()).toBe(false);
    expect(sink).toHaveBeenCalledTimes(1);
    await expect(
      player.setOutputDevice("speaker-3"),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("meeting audio playback", () => {
  it("controls microphone and screen groups independently while member mute still applies to every source", async () => {
    const mic = track(),
      shared1 = track(),
      shared2 = track();
    connect(new Stream([mic, shared1, shared2]));
    setAppState("session", "clientViewData", "alice", {
      audioSources: [
        { mid: "1", kind: "microphone" },
        { mid: "3", kind: "screen", videoMid: "2" },
        { mid: "5", kind: "screen", videoMid: "4" },
      ],
      audioTracks: [
        { mid: "1", trackId: mic.id },
        { mid: "3", trackId: shared1.id },
        { mid: "5", trackId: shared2.id },
      ],
      videoTracks: [
        { mid: "2", trackId: "screen-1" },
        { mid: "4", trackId: "screen-2" },
      ],
    });
    const view = setup();
    await flush();
    const output =
      view.container.querySelector("audio")!.srcObject;
    const microphoneId = JSON.stringify(["alice", null]);
    const firstScreenId = JSON.stringify([
      "alice",
      "screen-1",
    ]);
    player.setSourceMuted("alice", firstScreenId, true);
    expect([
      mic.enabled,
      shared1.enabled,
      shared2.enabled,
    ]).toEqual([true, false, true]);
    expect(player.isPeerMuted("alice")).toBe(false);
    player.setSourceMuted("alice", microphoneId, true);
    expect([
      mic.enabled,
      shared1.enabled,
      shared2.enabled,
    ]).toEqual([false, false, true]);
    player.setPeerMuted("alice", true);
    expect([
      mic.enabled,
      shared1.enabled,
      shared2.enabled,
    ]).toEqual([false, false, false]);
    player.setSourceMuted("alice", firstScreenId, false);
    expect([
      mic.enabled,
      shared1.enabled,
      shared2.enabled,
    ]).toEqual([false, true, false]);
    expect(player.isPeerMuted("alice")).toBe(false);
    player.setPlay(false);
    player.setPeerMuted("alice", false);
    expect([
      mic.enabled,
      shared1.enabled,
      shared2.enabled,
    ]).toEqual([true, true, true]);
    expect(player.playState()).toBe(false);
    expect(
      view.container.querySelector("audio")!.srcObject,
    ).toBe(output);
    player.setSourceMuted("alice", microphoneId, true);
    const replacementMic = track();
    // SessionService updates the stream without replacing peer metadata.
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "stream",
      new Stream([
        replacementMic,
        shared1,
        shared2,
      ]) as unknown as MediaStream,
    );
    expect([
      replacementMic.enabled,
      shared1.enabled,
      shared2.enabled,
    ]).toEqual([false, true, true]);
    setAppState(
      "session",
      "clientViewData",
      "alice",
      "audioTracks",
      [
        { mid: "1", trackId: replacementMic.id },
        { mid: "3", trackId: shared1.id },
        { mid: "5", trackId: shared2.id },
      ],
    );
    expect([
      replacementMic.enabled,
      shared1.enabled,
      shared2.enabled,
    ]).toEqual([false, true, true]);
    expect(player.playState()).toBe(false);
  });

  it("reapplies source mute when audio metadata arrives after its received track", () => {
    const mic = track(),
      shared = track();
    connect(new Stream([mic, shared]));
    setup();
    player.setSourceMuted(
      "alice",
      JSON.stringify(["alice", "screen"]),
      true,
    );
    expect(shared.enabled).toBe(true);
    setAppState("session", "clientViewData", "alice", {
      audioSources: [
        { mid: "3", kind: "screen", videoMid: "2" },
      ],
      audioTracks: [{ mid: "3", trackId: shared.id }],
      videoTracks: [{ mid: "2", trackId: "screen" }],
    });
    expect(shared.enabled).toBe(false);
    expect(mic.enabled).toBe(true);
  });

  it("mutes only the chosen member, keeps new and reconnected tracks muted, and preserves global mute when unmuting", async () => {
    const microphone = track(),
      sharedAudio = track(),
      other = track();
    const stream = new Stream([microphone, sharedAudio]);
    connect(stream);
    setAppState("session", "clientViewData", "bob", {
      clientId: "bob",
      name: "Bob",
      stream: new Stream([other]) as unknown as MediaStream,
    } as ClientInfo);
    const view = setup();
    await flush();
    const output =
      view.container.querySelector("audio")!.srcObject;
    expect(player.hasPeerAudio("alice")).toBe(true);
    player.setPeerMuted("alice", true);
    expect(microphone.enabled).toBe(false);
    expect(sharedAudio.enabled).toBe(false);
    expect(other.enabled).toBe(true);
    expect(player.isPeerMuted("alice")).toBe(true);
    expect(player.isPeerMuted("bob")).toBe(false);
    expect(
      view.container.querySelector("audio")!.srcObject,
    ).toBe(output);
    const added = track();
    stream.add(added);
    expect(added.enabled).toBe(false);
    player.setPlay(false);
    setAppState(
      "session",
      "clientViewData",
      "alice",
      undefined!,
    );
    expect(player.hasPeerAudio("alice")).toBe(false);
    const replacement = track();
    connect(new Stream([replacement]));
    expect(replacement.enabled).toBe(false);
    expect(player.hasPeerAudio("alice")).toBe(true);
    player.setPeerMuted("alice", false);
    expect(replacement.enabled).toBe(true);
    expect(other.enabled).toBe(true);
    expect(player.playState()).toBe(false);
  });

  it("preserves global mute across remote track replacement and reconnect", async () => {
    connect(new Stream([track()]));
    const view = setup();
    await flush();
    expect(player.playState()).toBe(true);
    player.setPlay(false);
    const plays = vi.mocked(HTMLMediaElement.prototype.play)
      .mock.calls.length;
    connect(new Stream([track()]));
    await flush();
    expect(player.playState()).toBe(false);
    expect(
      HTMLMediaElement.prototype.play,
    ).toHaveBeenCalledTimes(plays);
    setAppState(
      "session",
      "clientViewData",
      "alice",
      undefined!,
    );
    expect(player.hasAudio()).toBe(false);
    connect(new Stream([track()]));
    await flush();
    expect(
      HTMLMediaElement.prototype.play,
    ).toHaveBeenCalledTimes(plays);
    player.setPlay(true);
    await flush();
    expect(player.playState()).toBe(true);
    expect(
      view.container.querySelector("audio")?.srcObject,
    ).toBeTruthy();
  });

  it("lets an explicit gesture retry blocked autoplay", async () => {
    vi.mocked(
      HTMLMediaElement.prototype.play,
    ).mockRejectedValueOnce(
      new DOMException("blocked", "NotAllowedError"),
    );
    connect(new Stream([track()]));
    setup();
    await flush();
    expect(player.playState()).toBe(false);
    player.setPlay(true);
    await flush();
    expect(
      HTMLMediaElement.prototype.play,
    ).toHaveBeenCalledTimes(2);
    expect(player.playState()).toBe(true);
  });

  it("ignores detached streams and releases playback on unmount", async () => {
    const oldStream = new Stream([track()]);
    connect(oldStream);
    const view = setup();
    await flush();
    const activeTrack = track();
    connect(new Stream([activeTrack]));
    await flush();
    const audio = view.container.querySelector("audio")!;
    oldStream.add(track());
    await flush();
    expect(
      (audio.srcObject as unknown as Stream).tracks,
    ).toEqual([activeTrack]);
    const plays = vi.mocked(HTMLMediaElement.prototype.play)
      .mock.calls.length;
    view.unmount();
    oldStream.add(track());
    await flush();
    expect(audio.srcObject).toBeNull();
    expect(
      HTMLMediaElement.prototype.play,
    ).toHaveBeenCalledTimes(plays);
  });

  it("removes ended audio and ignores non-audio addtrack events", async () => {
    const active = track();
    const media = new Stream([active]);
    connect(media);
    setup();
    await flush();
    const plays = vi.mocked(HTMLMediaElement.prototype.play)
      .mock.calls.length;
    media.add({
      kind: "video",
      readyState: "live",
    } as MediaStreamTrack);
    await flush();
    expect(
      HTMLMediaElement.prototype.play,
    ).toHaveBeenCalledTimes(plays);
    (active as unknown as Track).end();
    expect(player.hasAudio()).toBe(false);
    expect(player.playState()).toBe(false);
  });
});
