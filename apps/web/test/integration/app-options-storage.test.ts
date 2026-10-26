// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { STORAGE_KEYS } from "@/constants";
import { RangeFile } from "@weblink/platform";
import type { ChunkCache } from "@/libs/domain/file";

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
  vi.unstubAllGlobals();
});

it("restores a paged background image and releases its URL when cleared", async () => {
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(
        () => "blob:background",
      );
      static revokeObjectURL = vi.fn();
    },
  );
  const { setAppState } = await boot();
  const { backgroundImage } = await import("@/options");
  const bytes = new TextEncoder().encode("image bytes");
  const file = new RangeFile(
    "background.png",
    bytes.length,
    "image/png",
    1,
    async (offset, length) =>
      bytes.slice(offset, offset + length).buffer,
  );
  setAppState("cache", {
    status: "ready",
    caches: {
      background: {
        getFile: async () => file,
      } as unknown as ChunkCache,
    },
  });
  try {
    setAppState("options", "backgroundImage", "background");
    await vi.waitFor(() =>
      expect(backgroundImage()).toBe("blob:background"),
    );
    expect(URL.createObjectURL).toHaveBeenCalledWith(
      expect.objectContaining({ type: "image/png" }),
    );
  } finally {
    setAppState("options", "backgroundImage", undefined);
  }
  expect(backgroundImage()).toBeUndefined();
  expect(URL.revokeObjectURL).toHaveBeenCalledOnce();
});

it("migrates session playback suppression to a persistent preference", async () => {
  sessionStorage.setItem(
    "mediaConstraints",
    JSON.stringify({
      speaker: { suppressLocalAudioPlayback: true },
    }),
  );
  const { appState } = await boot();
  expect(appState.options.suppressLocalAudioPlayback).toBe(
    true,
  );
  expect(saved().suppressLocalAudioPlayback).toBe(true);
  const { setAppOptions } = await import("@/options");
  setAppOptions("suppressLocalAudioPlayback", false);
  expect(saved().suppressLocalAudioPlayback).toBe(false);
});

it("prefers the saved playback setting over the legacy session setting", async () => {
  sessionStorage.setItem(
    "mediaConstraints",
    JSON.stringify({
      speaker: { suppressLocalAudioPlayback: true },
    }),
  );
  store({ suppressLocalAudioPlayback: false });
  const { appState } = await boot();
  expect(appState.options.suppressLocalAudioPlayback).toBe(
    false,
  );
});

it("round-trips current settings while discarding unknown fields at every settings level", async () => {
  store({
    maxConcurrentTransfers: 7,
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
  const { appState } = await boot();
  const current = saved();
  expect(appState.options).not.toHaveProperty(
    "redirectToClient",
  );
  expect(current).toMatchObject({
    maxConcurrentTransfers: 7,
    backgroundImage: "wallpaper",
    backgroundPreset: "aurora",
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
      shareScreen: false,
      receiveContent: false,
    },
  });
  expect(current.roomConfigs).toEqual({
    room: { name: "Room", autoDownloadFiles: true },
  });
  for (const key of [
    "redirectToClient",
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

it.each([undefined, 0, -1, 1.5, 11, "5", null])(
  "restores the default concurrency for invalid or missing settings (%j)",
  async (value) => {
    store({ maxConcurrentTransfers: value });
    const { appState } = await boot();
    expect(appState.options.maxConcurrentTransfers).toBe(3);
    expect(saved().maxConcurrentTransfers).toBe(3);
  },
);

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

it.each([true, false, "true", null])(
  "persists a boolean control visibility preference and rejects malformed values (%j)",
  async (value) => {
    store({ remoteControlWhitelistOnly: value });
    const { appState } = await boot();
    expect(
      appState.options.remoteControlWhitelistOnly,
    ).toBe(value === true);
    expect(saved().remoteControlWhitelistOnly).toBe(
      value === true,
    );
  },
);

it("restores the automation switch and only valid per-device scope decisions", async () => {
  store({
    automationEnabled: true,
    clientConfigs: {
      peer: {
        automation: {
          "shell.execute": "allow",
          "screen.read": "deny",
          "input.control": "ask",
          "accessibility.read": true,
          "unknown.scope": "allow",
        },
      },
    },
  });
  const { appState } = await boot();
  expect(appState.options.automationEnabled).toBe(true);
  expect(appState.options.mcpEnabled).toBe(true);
  expect(
    appState.options.clientConfigs.peer?.automation,
  ).toEqual({
    "shell.execute": "allow",
    "screen.read": "deny",
    "input.control": "ask",
  });
  const current = saved();
  for (const dispose of disposers.splice(0)) dispose();
  vi.resetModules();
  await boot();
  expect(saved()).toEqual(current);
});
it.each([undefined, "true", null, 1])(
  "does not enable automation for malformed preferences (%j)",
  async (automationEnabled) => {
    store({ automationEnabled });
    const { appState } = await boot();
    expect(appState.options.automationEnabled).toBe(false);
  },
);

it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "persists independent automation=%s and MCP=%s preferences",
  async (automationEnabled, mcpEnabled) => {
    store({ automationEnabled, mcpEnabled });
    const { appState } = await boot();
    expect(appState.options.automationEnabled).toBe(
      automationEnabled,
    );
    expect(appState.options.mcpEnabled).toBe(mcpEnabled);
    expect(saved()).toMatchObject({
      automationEnabled,
      mcpEnabled,
    });
  },
);
it.each(["true", null, 1])(
  "does not migrate over an invalid explicit MCP preference (%j)",
  async (mcpEnabled) => {
    store({ automationEnabled: true, mcpEnabled });
    const { appState } = await boot();
    expect(appState.options.automationEnabled).toBe(true);
    expect(appState.options.mcpEnabled).toBe(false);
  },
);
