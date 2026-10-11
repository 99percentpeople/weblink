// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { STORAGE_KEYS } from "@/constants";

const disposers: (() => void)[] = [];
const boot = async () => {
  const { createRoot } = await import("solid-js");
  const { initializeAppOptions } =
    await import("@/options");
  const state = await import("@/libs/state/app-state");
  createRoot((dispose) => {
    disposers.push(dispose);
    initializeAppOptions();
  });
  return state;
};
const saved = () =>
  JSON.parse(
    localStorage.getItem(STORAGE_KEYS.appOptions)!,
  );
const store = (value: unknown) =>
  localStorage.setItem(
    STORAGE_KEYS.appOptions,
    JSON.stringify(value),
  );

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  vi.restoreAllMocks();
});

it("round-trips current settings while discarding unknown fields at every settings level", async () => {
  store({
    backgroundImage: "wallpaper",
    backgroundPreset: "aurora",
    redirectToClient: "peer",
    bufferedAmountLowThreshold: 128 * 1024,
    bufferedAmountHighWaterMark: 512 * 1024,
    autoDownloadMaxSize: 10 * 1024 * 1024,
    application: {
      automaticPictureInPicture: true,
      closeBehavior: "tray",
      obsolete: true,
    },
    notifications: { sound: false, obsolete: true },
    remotePointer: { fileDrop: true, obsolete: true },
    remoteTouch: { pointerSpeed: 2, obsolete: true },
    remoteKeyboard: {
      clipboardFiles: "off",
      obsolete: true,
    },
    remoteGamepad: {
      enabled: false,
      vibrationStrength: 0.4,
      obsolete: true,
    },
    clientConfigs: {
      peer: {
        name: "Peer",
        remoteControl: "deny",
        provideFileList: false,
        obsolete: true,
      },
    },
    roomConfigs: {
      room: {
        name: "Room",
        autoDownloadFiles: true,
        autoDownloadMaxSize: 1,
        obsolete: true,
      },
    },
    nativeScreenEncoder: "mf:unavailable",
    nativeScreenCodec: "video/h265",
    audioSampleRate: 16000,
    audioChannelCount: 1,
    servers: {
      stuns: ["stun:example.test"],
      turns: [
        {
          url: "turn:example.test",
          username: "name",
          password: "password",
          authMethod: "longterm",
          obsolete: true,
        },
      ],
      obsolete: true,
    },
    channelsNumber: 4,
    showStreamStats: true,
    nativeColorFormat: "rgb",
    websocketUrl: "wss://obsolete.test",
    permissionHistoryImported: true,
  });
  await boot();
  const current = saved();
  expect(current).toMatchObject({
    backgroundImage: "wallpaper",
    backgroundPreset: "aurora",
    redirectToClient: "peer",
    bufferedAmountLowThreshold: 128 * 1024,
    bufferedAmountHighWaterMark: 512 * 1024,
    autoDownloadMaxSize: 10 * 1024 * 1024,
    application: {
      automaticPictureInPicture: true,
      closeBehavior: "tray",
    },
    notifications: { sound: false },
    remotePointer: { fileDrop: true },
    remoteTouch: { pointerSpeed: 2 },
    remoteKeyboard: { clipboardFiles: "off" },
    remoteGamepad: {
      enabled: false,
      vibrationStrength: 0.4,
    },
    nativeScreenEncoder: "mf:unavailable",
    nativeScreenCodec: "video/h265",
    audioSampleRate: 16000,
    audioChannelCount: 1,
    servers: {
      stuns: ["stun:example.test"],
      turns: [
        {
          url: "turn:example.test",
          username: "name",
          password: "password",
          authMethod: "longterm",
        },
      ],
    },
  });
  expect(current.clientConfigs).toEqual({
    peer: {
      name: "Peer",
      remoteControl: "deny",
      provideFileList: false,
    },
  });
  expect(current.roomConfigs).toEqual({
    room: { name: "Room", autoDownloadFiles: true },
  });
  for (const key of [
    "channelsNumber",
    "showStreamStats",
    "nativeColorFormat",
    "websocketUrl",
    "permissionHistoryImported",
  ])
    expect(current).not.toHaveProperty(key);
  expect(JSON.stringify(current)).not.toContain("obsolete");
  for (const dispose of disposers.splice(0)) dispose();
  vi.resetModules();
  await boot();
  expect(saved()).toEqual(current);
});

it("uses current defaults without importing obsolete preferences or historical permissions", async () => {
  localStorage.setItem(
    "meeting-auto-picture-in-picture",
    "true",
  );
  sessionStorage.setItem(
    "microphoneConstraints",
    JSON.stringify({ autoGainControl: false }),
  );
  sessionStorage.setItem(
    "speakerConstraints",
    JSON.stringify({ echoCancellation: true }),
  );
  sessionStorage.setItem(
    "videoConstraints",
    JSON.stringify({ frameRate: { max: 12 } }),
  );
  store({
    remoteGamepad: false,
    audioSampleRate: null,
    audioChannelCount: null,
    nativeWindowCaptureBackend: "auto",
    bufferedAmountLowThreshold: 4 * 1024 * 1024,
    roomConfigs: {
      room: {
        autoDownloadFiles: true,
        autoDownloadMaxSize: 1,
      },
    },
  });
  const { appState, setAppState } = await boot();
  expect(saved()).toMatchObject({
    application: { automaticPictureInPicture: false },
    remoteGamepad: { enabled: true },
    audioSampleRate: 48000,
    audioChannelCount: 2,
    nativeWindowCaptureBackend: "wgc",
    bufferedAmountLowThreshold: 64 * 1024,
    bufferedAmountHighWaterMark: 256 * 1024,
    autoDownloadMaxSize: 5 * 1024 * 1024,
    roomConfigs: { room: { autoDownloadFiles: true } },
  });
  expect(
    appState.media.constraints.microphone.autoGainControl,
  ).not.toBe(false);
  expect(
    appState.media.constraints.speaker.echoCancellation,
  ).toBe(false);
  expect(
    appState.media.constraints.video.frameRate,
  ).toEqual({ max: 60 });
  setAppState("message", "clients", [
    {
      clientId: "historic",
      name: "Historic",
      avatar: null,
    },
  ]);
  setAppState("message", "conversations", [
    {
      id: "old-room",
      kind: "room",
      roomId: "old",
      namespace: "server",
      title: "Old room",
      labelIds: [],
      createdAt: 1,
    },
  ]);
  setAppState("message", "status", "ready");
  expect(
    appState.options.clientConfigs.historic,
  ).toBeUndefined();
  expect(
    appState.options.roomConfigs["old-room"],
  ).toBeUndefined();
});

it("continues to restore current session media constraints", async () => {
  sessionStorage.setItem(
    "mediaConstraints",
    JSON.stringify({
      microphone: { autoGainControl: false },
      speaker: { echoCancellation: true },
      video: { frameRate: { max: 30 } },
    }),
  );
  const { appState } = await boot();
  expect(appState.media.constraints).toMatchObject({
    microphone: { autoGainControl: false },
    speaker: { echoCancellation: true },
    video: { frameRate: { max: 30 } },
  });
});

it.each([
  ["auto", "video/h264"],
  ["software", null],
  ["mf:test", null],
])(
  "resets obsolete mixed encoding selections %s / %s to automatic",
  async (encoder, codec) => {
    store({
      nativeScreenEncoder: encoder,
      nativeScreenCodec: codec,
    });
    await boot();
    expect(saved()).toMatchObject({
      nativeScreenEncoder: "auto",
      nativeScreenCodec: null,
    });
  },
);

it.each([null, [], "broken", 42])(
  "recovers from an invalid stored settings object (%j)",
  async (value) => {
    store(value);
    await boot();
    expect(saved()).toMatchObject({
      audioSampleRate: 48000,
      audioChannelCount: 2,
      clientConfigs: {},
      roomConfigs: {},
      nativeWindowCaptureBackend: "wgc",
    });
  },
);
