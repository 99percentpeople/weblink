// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { createRoot, createSignal } from "solid-js";
import type {
  AudioCaptureFormat,
  PlatformRuntime,
} from "@weblink/platform";
import { createAppMediaCapabilities } from "@/libs/state/create-app-media-capabilities";
import type { MeetingDeviceAccessState } from "@/libs/domain/meeting-devices";

const formats: AudioCaptureFormat[] = [
  { sampleRate: 48000, channelCount: 2 },
];
const disposers: (() => void)[] = [];
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  vi.restoreAllMocks();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
function device(id: string, rate = 48000): MediaDeviceInfo {
  return {
    deviceId: id,
    groupId: id,
    kind: "audioinput",
    label: id,
    getCapabilities: () => ({
      sampleRate: { min: rate, max: rate },
      channelCount: { min: 1, max: 2 },
    }),
  } as unknown as MediaDeviceInfo;
}
function fixture(kind = "desktop") {
  const api = {
    getCapabilities: vi.fn().mockResolvedValue({
      runtime: kind,
      nativeScreenCapture: true,
      displayRefreshRates: [144],
    }),
    encoders: vi
      .fn()
      .mockResolvedValue([
        { id: "software", codecs: ["video/h264"] },
      ]),
    codecs: vi.fn().mockResolvedValue(["audio/opus"]),
    backends: vi.fn().mockResolvedValue({
      screen: [{ id: "wgc" }],
      window: [],
    }),
    audioFormats: vi.fn().mockResolvedValue(formats),
  };
  const [devices, setDevices] = createSignal<
    MediaDeviceInfo[]
  >([device("mic")]);
  const [permission, setPermission] =
    createSignal<MeetingDeviceAccessState>("granted");
  const [stream, setStream] =
    createSignal<MediaStream | null>(null);
  let dispose!: () => void;
  const state = createRoot((stop) => {
    dispose = stop;
    return createAppMediaCapabilities({
      platform: {
        kind,
        getCapabilities: api.getCapabilities,
        capture: { backends: api.backends },
        screenShare: {
          encoders: api.encoders,
          codecs: api.codecs,
          audioFormats: api.audioFormats,
        },
      } as unknown as PlatformRuntime,
      permissions: { devices, state: permission },
      stream,
    });
  });
  disposers.push(dispose);
  return {
    state,
    api,
    setDevices,
    setPermission,
    setStream,
    dispose,
  };
}

it("discovers once per app and reuses it across consumers and unchanged focus events", async () => {
  const { state, api } = fixture();
  await vi.waitFor(() =>
    expect(state.audioFormats()).toEqual(formats),
  );
  await Promise.all([
    state.ready(),
    state.ready(),
    state.captureBackends(),
    state.captureBackends(),
  ]);
  expect(api.getCapabilities).toHaveBeenCalledOnce();
  window.dispatchEvent(new Event("focus"));
  await vi.waitFor(() =>
    expect(api.getCapabilities).toHaveBeenCalledTimes(2),
  );
  expect(api.encoders).toHaveBeenCalledOnce();
  expect(api.backends).toHaveBeenCalledOnce();
  expect(api.audioFormats).toHaveBeenCalledOnce();
  expect(api.codecs).toHaveBeenCalledOnce();
  expect(state.frameRates()).toContain(144);
});
it("refreshes audio formats for audio device changes while reusing other native capabilities", async () => {
  const { state, api, setDevices } = fixture();
  await vi.waitFor(() =>
    expect(state.audioFormatsLoading()).toBe(false),
  );
  setDevices([device("mic")]);
  setDevices([
    device("mic"),
    {
      kind: "videoinput",
      deviceId: "camera",
    } as MediaDeviceInfo,
  ]);
  expect(api.audioFormats).toHaveBeenCalledOnce();
  setDevices([device("replacement", 44100)]);
  await vi.waitFor(() =>
    expect(api.audioFormats).toHaveBeenCalledTimes(2),
  );
  expect(state.browserSampling()[0].sampleRates).toEqual([
    44100,
  ]);
  expect(api.encoders).toHaveBeenCalledOnce();
});
it("shares permission and selected microphone changes without acquiring capture permission", () => {
  const { state, api, setDevices, setPermission } =
    fixture("browser");
  setDevices([device("first"), device("second", 16000)]);
  state.setMicrophoneId("second");
  expect(state.browserSampling()[0].sampleRates).toEqual([
    16000,
  ]);
  setPermission("denied");
  expect(state.browserSampling()[0].sampleRates).toBeNull();
  setPermission("granted");
  expect(state.browserSampling()[0].sampleRates).toEqual([
    16000,
  ]);
  expect(api.audioFormats).not.toHaveBeenCalled();
  expect(api.getCapabilities).not.toHaveBeenCalled();
});
it("observes shared stream track changes and releases listeners with AppState", () => {
  const { state, setDevices, setStream, dispose } =
    fixture("browser");
  setDevices([]);
  const track = Object.assign(new EventTarget(), {
    kind: "audio",
    contentHint: "music",
    readyState: "live",
    getSettings: () => ({
      sampleRate: 44100,
      channelCount: 2,
    }),
  });
  let tracks = [track];
  const stream = Object.assign(new EventTarget(), {
    getAudioTracks: () => tracks,
  });
  setStream(stream as unknown as MediaStream);
  expect(state.browserSampling()).toHaveLength(2);
  track.readyState = "ended";
  track.dispatchEvent(new Event("ended"));
  expect(state.browserSampling()).toHaveLength(1);
  tracks = [];
  stream.dispatchEvent(new Event("removetrack"));
  expect(state.browserSampling()).toHaveLength(1);
  const getter = vi.spyOn(stream, "getAudioTracks");
  dispose();
  getter.mockClear();
  stream.dispatchEvent(new Event("addtrack"));
  expect(getter).not.toHaveBeenCalled();
});
it("contains audio discovery failures and retries without re-probing encoders", async () => {
  const { state, api } = fixture();
  api.audioFormats.mockRejectedValueOnce(
    new Error("unavailable"),
  );
  await vi.waitFor(() =>
    expect(state.audioFormatsFailed()).toBe(true),
  );
  expect(state.audioFormats()).toBeUndefined();
  await state.refresh();
  await vi.waitFor(() =>
    expect(state.audioFormats()).toEqual(formats),
  );
  expect(state.audioFormatsFailed()).toBe(false);
  expect(api.encoders).toHaveBeenCalledOnce();
});
it("discards stale native responses and coalesces refreshes while discovery is in flight", async () => {
  const { state, api } = fixture();
  const pending = deferred<AudioCaptureFormat[]>();
  api.audioFormats.mockReturnValueOnce(pending.promise);
  await vi.waitFor(() =>
    expect(api.audioFormats).toHaveBeenCalledOnce(),
  );
  await Promise.all([
    state.refresh(true),
    state.refresh(true),
  ]);
  expect(api.audioFormats).toHaveBeenCalledOnce();
  pending.resolve([{ sampleRate: 16000, channelCount: 1 }]);
  await vi.waitFor(() =>
    expect(state.audioFormats()).toEqual(formats),
  );
  expect(api.audioFormats).toHaveBeenCalledTimes(2);
});
it("ignores late results and stops focus observation after AppState disposal", async () => {
  const { state, api, dispose } = fixture();
  const pending = deferred<AudioCaptureFormat[]>();
  api.audioFormats.mockReturnValueOnce(pending.promise);
  await vi.waitFor(() =>
    expect(api.audioFormats).toHaveBeenCalledOnce(),
  );
  dispose();
  pending.resolve(formats);
  await pending.promise;
  await Promise.resolve();
  window.dispatchEvent(new Event("focus"));
  expect(state.audioFormats()).toBeUndefined();
  expect(api.getCapabilities).toHaveBeenCalledOnce();
});
