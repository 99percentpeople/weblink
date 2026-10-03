import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createRoot } from "solid-js";
import { reconcile } from "solid-js/store";
import type { MeetingMediaPort } from "@/libs/application/meeting-media-service";
import { createMeetingMedia } from "@/libs/state/create-meeting-media";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";

const f = vi.hoisted(() => ({
  port: undefined as MeetingMediaPort | undefined,
  capture: vi.fn(),
  display: vi.fn(),
  native: vi.fn(),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: { remoteControl: { screen: {} } },
}));
vi.mock("@/libs/platform/runtime", () => ({
  platform: {
    getCapabilities: async () => ({
      nativeScreenCapture: true,
    }),
    capture: {},
    screenShare: {},
  },
}));
vi.mock("@/libs/application/native-screen-service", () => ({
  createNativeScreenStream: f.native,
  getNativeScreenPublication: () => undefined,
}));
vi.mock("@/libs/application/live-video-settings", () => ({
  createLiveVideoSettings: () => ({
    sync() {},
    dispose() {},
  }),
}));
vi.mock("@/libs/application/meeting-media-service", () => ({
  createMeetingMediaController: (
    port: MeetingMediaPort,
  ) => {
    f.port = port;
    return {
      sync() {},
      dispose() {},
      cancelRequests() {},
      error: () => null,
      microphoneOn: () => false,
      selectedMicrophoneId: () => "",
      cameraOn: () => false,
    };
  },
}));
let dispose: () => void;
beforeEach(() => {
  setAppState(reconcile(createInitialAppState()));
  setAppState("options", {
    audioSampleRate: 16000,
    audioChannelCount: 1,
    preferredAudioCodec: "audio/pcma",
    nativeAudioCodec: "audio/opus",
  });
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(),
      getDisplayMedia: f.display,
    },
  });
  vi.clearAllMocks();
});
afterEach(() => {
  dispose?.();
  vi.unstubAllGlobals();
});
function mount(native = false) {
  createRoot((stop) => {
    dispose = stop;
    createMeetingMedia({
      state: {
        localStream: () => null,
        mediaCapabilities: {
          ready: async () => {},
          captureSupported: () => true,
          setMicrophoneId() {},
        },
        activeRoomConversationId: () => "room",
        replaceLocalStream() {},
        clearLocalStream() {},
        permissions: {
          media: {
            capture: f.capture,
            error: () => null,
            discoveryError: () => null,
          },
        },
      } as any,
      audio: {} as any,
      nativePicker: native
        ? ({
            choose: async () => ({
              sourceId: "monitor",
              backend: "wgc",
              audio: false,
            }),
            cancel() {},
          } as any)
        : undefined,
    });
  });
}

it("passes sampling preferences and exact device selection to microphone capture", async () => {
  mount();
  await f.port!.getUserMedia({
    audio: { deviceId: { exact: "microphone" } },
    video: false,
  });
  expect(f.capture).toHaveBeenCalledWith({
    audio: {
      ...appState.media.constraints.microphone,
      sampleRate: { ideal: 16000 },
      channelCount: { ideal: 1 },
      deviceId: { exact: "microphone" },
    },
    video: false,
  });
  await f.port!.getUserMedia({ audio: false, video: true });
  expect(f.capture.mock.lastCall![0].audio).toBe(false);
});

it("uses current preferences for browser screen audio while retaining audio processing preferences", async () => {
  mount();
  setAppState("options", "audioSampleRate", 48000);
  await f.port!.getDisplayMedia!();
  expect(f.display).toHaveBeenCalledWith(
    expect.objectContaining({
      audio: {
        ...appState.media.constraints.speaker,
        sampleRate: { ideal: 48000 },
        channelCount: { ideal: 1 },
      },
    }),
  );
});

it("forwards native audio format and codec without overriding the picker audio choice", async () => {
  mount(true);
  await f.port!.getDisplayMedia!();
  expect(f.native).toHaveBeenCalledWith(
    expect.anything(),
    expect.anything(),
    "monitor",
    expect.any(AbortSignal),
    expect.objectContaining({
      audio: false,
      audioSampleRate: 16000,
      audioChannelCount: 1,
      audioCodec: "audio/opus",
    }),
    { backend: "wgc" },
  );
});
