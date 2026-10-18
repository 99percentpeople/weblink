import { afterEach, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import { createRecording } from "@/libs/state/create-recording";
import type {
  RecordingSource,
  RecordingState,
} from "@/libs/application/recording-service";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import type { StoredFile } from "@weblink/platform";

const f = vi.hoisted(() => ({
  clients: {} as Record<string, unknown>,
  source: undefined as RecordingSource | undefined,
  changed: undefined as
    | ((state: RecordingState | null) => void)
    | undefined,
  complete: undefined as
    | ((result: {
        id: string;
        file: StoredFile;
      }) => Promise<void>)
    | undefined,
  createCache: vi.fn(async () => ({})),
  verifyReceived: vi.fn<() => Promise<StoredFile | null>>(),
  stop: vi.fn(async () => {}),
  pause: vi.fn(),
  resume: vi.fn(),
  sources: vi.fn(() => []),
}));
vi.mock("@/libs/state/app-state", () => ({
  appState: { session: { clientViewData: f.clients } },
}));
vi.mock("@/libs/application/cache-service", () => ({
  createCacheManager: () => ({
    storage: {},
    createCache: f.createCache,
    library: { verifyReceived: f.verifyReceived },
  }),
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: { getRecordingVideoSources: f.sources },
}));
vi.mock("@/libs/application/native-screen-service", () => ({
  getNativeScreenPublication: () => undefined,
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/application/recording-service", () => ({
  RecordingService: class {
    supported = true;
    constructor(
      private port: {
        changed(value: RecordingState | null): void;
        complete(result: {
          id: string;
          file: StoredFile;
        }): Promise<void>;
      },
    ) {
      f.changed = port.changed;
      f.complete = port.complete;
    }
    async start(source: RecordingSource) {
      f.source = source;
      this.port.changed({
        sourceId: source.id,
        name: source.name,
        phase: "recording",
        bytes: 0,
        elapsed: 0,
      });
    }
    sync() {
      if (f.source && !f.source.available())
        void this.stop();
    }
    stop = f.stop;
    pause = f.pause;
    resume = f.resume;
  },
}));
const track = (id: string, kind: "audio" | "video") =>
  ({ id, kind, readyState: "live" }) as MediaStreamTrack;
const stream = (...tracks: MediaStreamTrack[]) =>
  ({
    getTracks: () => tracks,
    getVideoTracks: () =>
      tracks.filter((t) => t.kind === "video"),
    getAudioTracks: () =>
      tracks.filter((t) => t.kind === "audio"),
  }) as MediaStream;
let dispose: (() => void) | undefined;
afterEach(() => {
  dispose?.();
  f.source = undefined;
  f.changed = undefined;
  f.complete = undefined;
  f.verifyReceived.mockReset();
  for (const key of Object.keys(f.clients))
    delete f.clients[key];
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
it.each(["camera", "screen"])(
  "records only the selected remote %s source's audio and stops when leaving",
  async (kind) => {
    const camera = track("camera", "video");
    const display = track("display", "video");
    const microphone = track("microphone", "audio");
    const screenAudio = track("screen-audio", "audio");
    f.clients.peer = {
      stream: stream(
        camera,
        display,
        microphone,
        screenAudio,
      ),
      audioTracks: [
        { trackId: microphone.id, mid: "0" },
        { trackId: screenAudio.id, mid: "1" },
      ],
      videoTracks: [
        { trackId: camera.id, mid: "2" },
        { trackId: display.id, mid: "3" },
      ],
      audioSources: [
        { kind: "microphone", mid: "0" },
        { kind: "screen", mid: "1", videoMid: "3" },
      ],
    };
    f.clients.other = {
      stream: stream(track("other-participant", "audio")),
    };
    const [room, setRoom] = createSignal<string | null>(
      "room",
    );
    const recording = createRoot((release) => {
      dispose = release;
      return createRecording({
        localStream: () => null,
        activeRoomConversationId: room,
      } as AppStateContextProps);
    });
    recording.start({
      id: "selected",
      name: "Peer",
      participantName: "Alice",
      avatar: "https://example.test/alice.png",
      sourceLabel: "Screen 2",
      local: false,
      participantId: "peer",
      kind,
      video: kind === "camera" ? camera : display,
      audio: kind === "camera" ? [] : [screenAudio],
    });
    expect(f.source?.audio).toEqual([
      kind === "camera" ? microphone : screenAudio,
    ]);
    expect(f.source?.local).toBe(false);
    f.source?.encodedVideoSources?.();
    expect(f.sources).toHaveBeenCalledWith(
      kind === "camera" ? camera : display,
      [kind === "camera" ? microphone : screenAudio],
    );
    expect(f.source?.available()).toBe(true);
    expect(recording.state()).toMatchObject({
      participantName: "Alice",
      avatar: "https://example.test/alice.png",
      sourceLabel: "Screen 2",
    });
    recording.pause();
    expect(f.pause).toHaveBeenCalledOnce();
    f.changed?.({
      sourceId: "selected",
      name: "Peer",
      phase: "paused",
      bytes: 1234,
      elapsed: 2000,
    });
    expect(recording.state()).toMatchObject({
      phase: "paused",
      participantName: "Alice",
      sourceLabel: "Screen 2",
    });
    recording.resume();
    expect(f.resume).toHaveBeenCalledOnce();
    // A reused participant ID must not keep recording a replaced stream.
    f.clients.peer = {
      stream: stream(track("replacement", "video")),
    };
    expect(f.source?.available()).toBe(false);
    f.changed?.({
      sourceId: "selected",
      name: "Peer",
      phase: "saving",
      bytes: 1234,
      elapsed: 2000,
    });
    expect(recording.state()).toMatchObject({
      phase: "saving",
      participantName: "Alice",
      avatar: "https://example.test/alice.png",
      sourceLabel: "Screen 2",
    });
    expect(f.stop).toHaveBeenCalledOnce();
    f.stop.mockClear();
    setRoom(null);
    await Promise.resolve();
    expect(f.stop).toHaveBeenCalledOnce();
  },
);

it("identifies direct local camera capture for recorder codec selection", () => {
  const camera = track("camera", "video");
  const recording = createRoot((release) => {
    dispose = release;
    return createRecording({
      localStream: () => stream(camera),
      activeRoomConversationId: () => "room",
    } as AppStateContextProps);
  });
  recording.start({
    id: "camera",
    name: "Camera",
    local: true,
    kind: "camera",
    video: camera,
    audio: [],
  });
  expect(f.source?.local).toBe(true);
  expect(f.source?.video).toBe(camera);
  expect(f.source?.available()).toBe(true);
});

function savedRecording() {
  const recording = createRoot((release) => {
    dispose = release;
    return createRecording({
      localStream: () => null,
      activeRoomConversationId: () => "room",
    } as AppStateContextProps);
  });
  const file = new File(["recorded"], "screen.mp4", {
    type: "video/mp4",
  });
  return { recording, file, result: { id: "saved", file } };
}

it("announces the final file only after library verification succeeds", async () => {
  const { recording, file, result } = savedRecording();
  let finish!: (file: StoredFile) => void;
  f.verifyReceived.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const saved = vi.fn();
  recording.onSaved(saved);
  const completed = f.complete!(result);
  await Promise.resolve();
  expect(f.createCache).toHaveBeenCalledWith("saved");
  expect(f.verifyReceived).toHaveBeenCalledOnce();
  expect(saved).not.toHaveBeenCalled();
  finish(file);
  await completed;
  expect(saved).toHaveBeenCalledOnce();
  expect(saved).toHaveBeenCalledWith({
    id: "saved",
    fileName: "screen.mp4",
  });
});

it.each([null, new Error("Verification failed")])(
  "does not announce an unavailable or unverified recording: %s",
  async (failure) => {
    const { recording, result } = savedRecording();
    if (failure)
      f.verifyReceived.mockRejectedValue(failure);
    else f.verifyReceived.mockResolvedValue(null);
    const saved = vi.fn();
    recording.onSaved(saved);
    await expect(f.complete!(result)).rejects.toThrow();
    expect(saved).not.toHaveBeenCalled();
  },
);

it("removes completion subscribers and isolates notification failures from a saved file", async () => {
  const { recording, file, result } = savedRecording();
  f.verifyReceived.mockResolvedValue(file);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const removed = vi.fn();
  recording.onSaved(removed)();
  recording.onSaved(() => {
    throw new Error("Notice failed");
  });
  const saved = vi.fn();
  recording.onSaved(saved);
  await expect(
    f.complete!(result),
  ).resolves.toBeUndefined();
  expect(removed).not.toHaveBeenCalled();
  expect(saved).toHaveBeenCalledOnce();
  dispose?.();
  await f.complete!(result);
  expect(saved).toHaveBeenCalledOnce();
});
