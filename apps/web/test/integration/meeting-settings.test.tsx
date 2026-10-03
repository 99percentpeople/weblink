import { platform } from "@/libs/platform/runtime";
import {
  AppStateContext,
  type AppStateContextProps,
} from "@/libs/state/app-state-context";
import { createAppSettings } from "@/libs/state/create-app-settings";
import type { AppPermissions } from "@/libs/state/create-app-permissions";
import type { JSX } from "solid-js";
import type { NativeEncoder } from "@weblink/platform";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render as renderView,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal, Show, Suspense } from "solid-js";
import { reconcile } from "solid-js/store";
import MeetingSettings from "@/components/settings/meeting-settings";
import VideoCaptureSettings from "@/components/settings/video-capture-settings";
import { nativeScreenOptions } from "@/libs/application/meeting-video-settings";
import AdvancedSettings from "@/components/settings/advanced-settings";
import {
  appState,
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
const native = vi.hoisted(() => ({
  capabilities: vi.fn(),
  codecs: vi.fn(),
  audioFormats: vi.fn(),
  encoders: vi.fn(),
  backends: vi.fn(),
  sources: vi.fn(),
  enabled: true,
  kind: "desktop",
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/platform/runtime", () => ({
  platform: {
    get kind() {
      return native.kind;
    },
    getCapabilities: native.capabilities,
    capture: {
      backends: native.backends,
      sources: native.sources,
    },
    get screenShare() {
      return native.enabled
        ? {
            codecs: native.codecs,
            audioFormats: native.audioFormats,
            encoders: native.encoders,
          }
        : undefined;
    },
  },
}));
vi.mock("@/options", async () => {
  const { setAppState } =
    await import("@/libs/state/app-state");
  return {
    setAppOptions: (...args: unknown[]) =>
      Reflect.apply(setAppState, undefined, [
        "options",
        ...args,
      ]),
  };
});
vi.mock("@/libs/application/ice-server-service", () => ({
  serverTurnCredentialsUrl: null,
}));
beforeEach(() => {
  native.enabled = true;
  native.kind = "desktop";
  native.sources.mockResolvedValue([]);
  setAppState(reconcile(createInitialAppState()));
  native.capabilities.mockResolvedValue({
    runtime: "desktop",
    displayRefreshRates: [60],
    nativeScreenCapture: true,
  });
  native.encoders.mockResolvedValue([
    {
      id: "software",
      name: "Software",
      hardware: false,
      codecs: ["video/vp8", "video/h264", "video/vp9"],
    },
    {
      id: "mf:test",
      name: "GPU H.264",
      hardware: true,
      codecs: ["video/h264"],
    },
    {
      id: "mf:test:h265",
      name: "GPU H.265",
      hardware: true,
      codecs: ["video/h265"],
    },
  ]);
  native.backends.mockResolvedValue({
    screen: [
      { id: "dxgi", name: "DXGI" },
      { id: "wgc", name: "WGC" },
    ],
    window: [{ id: "wgc", name: "WGC" }],
  });
  native.audioFormats.mockResolvedValue(
    [8000, 16000, 32000, 44100, 48000].flatMap(
      (sampleRate) =>
        [1, 2].map((channelCount) => ({
          sampleRate,
          channelCount,
        })),
    ),
  );
  native.codecs.mockResolvedValue([
    "video/vp8",
    "video/h264",
    "video/h265",
  ]);
  vi.stubGlobal("RTCRtpSender", {
    getCapabilities: (kind: string) => ({
      codecs: [
        {
          mimeType:
            kind === "video" ? "video/VP9" : "audio/opus",
        },
      ],
    }),
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  Element.prototype.scrollIntoView = vi.fn();
  window.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
function render(view: () => JSX.Element) {
  return renderView(() => {
    const settings = createAppSettings({
      platform,
      permissions: {
        devices: () => [],
        state: () => "prompt",
      } as unknown as AppPermissions["media"],
      stream: () => appState.session.localStream,
    });
    return (
      <AppStateContext.Provider
        value={settings as AppStateContextProps}
      >
        {view()}
      </AppStateContext.Provider>
    );
  });
}
const choose = async (name: string, value: string) => {
  const trigger = await screen.findByRole("button", {
    name: new RegExp(name),
  });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const option = await screen.findByRole("option", {
    name: value,
  });
  fireEvent.click(option);
};
it("updates capture settings while preserving the existing bitrate and browser preferences", async () => {
  setAppState("options", {
    videoMaxBitrate: 8_000_000,
    preferredVideoCodec: "video/vp9",
  });
  render(() => <MeetingSettings />);
  await choose(
    "setting.meeting_settings.resolution",
    "720p",
  );
  await choose(
    "setting.meeting_settings.frame_rate",
    "60 FPS",
  );
  expect(appState.options.videoResolution).toBe("720p");
  expect(appState.options.videoFrameRate).toBe(60);
  expect(appState.options.videoMaxBitrate).toBe(8_000_000);
  expect(appState.options.preferredVideoCodec).toBe(
    "video/vp9",
  );
});
it("uses native capabilities for exact screen encoding without changing browser preferences", async () => {
  render(() => <MeetingSettings />);
  await choose(
    "setting.meeting_settings.native_encoder",
    "H.264",
  );
  expect(appState.options.nativeScreenEncoder).toBe(
    "software",
  );
  expect(appState.options.nativeScreenCodec).toBe(
    "video/h264",
  );
  expect(appState.options.preferredVideoCodec).toBeNull();
  expect(native.encoders).toHaveBeenCalledOnce();
  expect(native.codecs).toHaveBeenCalledWith("audio");
});
it("selects single, double and triple readback buffers for the next native share", async () => {
  render(() => <MeetingSettings />);
  const key = "setting.meeting_settings.readback_buffers";
  expect(
    await screen.findByRole("button", {
      name: new RegExp(key),
    }),
  ).toHaveTextContent(`${key}_2`);
  for (const count of [1, 3, 2] as const) {
    await choose(key, `${key}_${count}`);
    expect(appState.options.nativeReadbackBuffers).toBe(
      count,
    );
    expect(
      nativeScreenOptions(appState.options).readbackBuffers,
    ).toBe(count);
  }
});
it("hides native encoding controls when native capture is unavailable", async () => {
  native.capabilities.mockResolvedValue({
    nativeScreenCapture: false,
  });
  render(() => <MeetingSettings />);
  await waitFor(() =>
    expect(native.capabilities).toHaveBeenCalled(),
  );
  expect(native.codecs).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", {
      name: /setting.meeting_settings.native_encoder/,
    }),
  ).toBeNull();
});
it("removes streaming controls from Advanced", () => {
  render(() => <AdvancedSettings />);
  expect(
    screen.queryByText(
      "setting.meeting_settings.stream.title",
    ),
  ).toBeNull();
  expect(
    screen.queryByText(
      "setting.advanced_settings.stream.title",
    ),
  ).toBeNull();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function mountSettingsShell() {
  const fallback = vi.fn();
  const Loading = () => {
    fallback();
    return <p>Settings loading</p>;
  };
  render(() => {
    const [meeting, setMeeting] = createSignal(false);
    return (
      <section role="dialog" aria-label="Settings">
        <Suspense fallback={<Loading />}>
          <button
            onClick={() => setMeeting((value) => !value)}
          >
            Toggle meeting settings
          </button>
          <Show when={meeting()}>
            <MeetingSettings />
          </Show>
        </Suspense>
      </section>
    );
  });
  const navigation = screen.getByRole("button", {
    name: "Toggle meeting settings",
  });
  const open = () => fireEvent.click(navigation);
  return { fallback, navigation, open };
}

it("keeps the dialog interactive throughout capability and codec loading", async () => {
  const capabilities = deferred<{
    runtime: "desktop";
    nativeScreenCapture: boolean;
  }>();
  const encoders = deferred<NativeEncoder[]>();
  native.capabilities.mockReturnValue(capabilities.promise);
  native.encoders.mockReturnValue(encoders.promise);
  const shell = mountSettingsShell();
  shell.open();
  const nativeEncoder = screen.getByRole("button", {
    name: /setting.meeting_settings.native_encoder/,
  });
  expect(nativeEncoder).toBeDisabled();
  expect(
    screen.getByText(
      "setting.meeting_settings.encoders_loading",
    ),
  ).toBeInTheDocument();
  await waitFor(() =>
    expect(native.capabilities).toHaveBeenCalledOnce(),
  );
  expect(shell.fallback).not.toHaveBeenCalled();
  expect(shell.navigation).toBeInTheDocument();
  await choose(
    "setting.meeting_settings.resolution",
    "720p",
  );
  const resolution = screen.getByRole("button", {
    name: /setting.meeting_settings.resolution/,
  });
  capabilities.resolve({
    runtime: "desktop",
    nativeScreenCapture: true,
  });
  await waitFor(() =>
    expect(native.encoders).toHaveBeenCalledOnce(),
  );
  expect(shell.fallback).not.toHaveBeenCalled();
  expect(resolution).toBeInTheDocument();
  // Cheap capture queries become usable without waiting for hardware probes.
  await choose(
    "meeting.native_screen.screen_backend",
    "DXGI",
  );
  expect(nativeEncoder).toBeDisabled();
  encoders.resolve([
    {
      id: "software",
      name: "Software",
      hardware: false,
      codecs: ["video/h264"],
    },
  ]);
  await screen.findByRole("button", {
    name: /setting.meeting_settings.native_encoder/,
  });
  expect(shell.fallback).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(nativeEncoder).not.toBeDisabled(),
  );
  expect(
    screen.getByRole("button", {
      name: /setting.meeting_settings.native_encoder/,
    }),
  ).toBe(nativeEncoder);
  expect(
    screen.getByRole("button", {
      name: /setting.meeting_settings.resolution/,
    }),
  ).toBe(resolution);
  expect(appState.options.videoResolution).toBe("720p");
});

it("does not suspend or query native capabilities in a browser", async () => {
  native.kind = "browser";
  const shell = mountSettingsShell();
  shell.open();
  await screen.findByRole("button", {
    name: /setting.meeting_settings.resolution/,
  });
  expect(
    screen.queryByText(
      "setting.meeting_settings.native_encoder",
    ),
  ).toBeNull();
  expect(shell.fallback).not.toHaveBeenCalled();
  expect(native.capabilities).not.toHaveBeenCalled();
  expect(native.codecs).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", {
      name: /setting.meeting_settings.native_audio_codec/,
    }),
  ).toBeNull();
});

it("finishes shared discovery after leaving the tab and reuses it on reopen", async () => {
  const capabilities = deferred<{
    runtime: "desktop";
    nativeScreenCapture: boolean;
  }>();
  native.capabilities.mockReturnValue(capabilities.promise);
  const shell = mountSettingsShell();
  shell.open();
  await waitFor(() =>
    expect(native.capabilities).toHaveBeenCalledOnce(),
  );
  shell.open();
  capabilities.resolve({
    runtime: "desktop",
    nativeScreenCapture: true,
  });
  await capabilities.promise;
  await waitFor(() =>
    expect(native.codecs).toHaveBeenCalledWith("audio"),
  );
  expect(
    screen.queryByRole("button", {
      name: /setting.meeting_settings.native_encoder/,
    }),
  ).toBeNull();
  shell.open();
  await waitFor(() =>
    expect(
      screen.getByRole("button", {
        name: /setting.meeting_settings.native_encoder/,
      }),
    ).not.toBeDisabled(),
  );
  expect(native.capabilities).toHaveBeenCalledOnce();
  expect(native.encoders).toHaveBeenCalledOnce();
  expect(native.backends).toHaveBeenCalledOnce();
  expect(native.audioFormats).toHaveBeenCalledOnce();
});

it.each(["capabilities", "encoders"] as const)(
  "keeps a failed %s query inside the meeting page",
  async (query) => {
    native[query].mockRejectedValue(
      new Error("IPC failed"),
    );
    const shell = mountSettingsShell();
    shell.open();
    if (query === "encoders") {
      await screen.findByText(
        "setting.meeting_settings.native_unavailable",
      );
      expect(
        screen.getByRole("button", {
          name: /setting.meeting_settings.native_encoder/,
        }),
      ).toBeDisabled();
    } else {
      await waitFor(() =>
        expect(native.capabilities).toHaveBeenCalledOnce(),
      );
      await waitFor(() =>
        expect(
          screen.queryByText(
            "setting.meeting_settings.native_encoder",
          ),
        ).toBeNull(),
      );
      expect(native.codecs).not.toHaveBeenCalled();
    }
    expect(shell.fallback).not.toHaveBeenCalled();
    expect(shell.navigation).toBeInTheDocument();
    await choose(
      "setting.meeting_settings.frame_rate",
      "60 FPS",
    );
    expect(appState.options.videoFrameRate).toBe(60);
  },
);

it("offers high frame rates from connected displays and preserves the selected native rate", async () => {
  native.capabilities.mockResolvedValue({
    runtime: "desktop",
    nativeScreenCapture: true,
    displayRefreshRates: [60, 144],
  });
  render(() => <MeetingSettings />);
  await choose(
    "setting.meeting_settings.frame_rate",
    "144 FPS",
  );
  expect(appState.options.videoFrameRate).toBe(144);
  const trigger = screen.getByRole("button", {
    name: /setting.meeting_settings.frame_rate/,
  });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(
    screen.queryByRole("option", { name: "165 FPS" }),
  ).toBeNull();
});

it("waits for display information before reconciling a saved high frame rate", async () => {
  const capabilities = deferred<{
    runtime: "desktop";
    nativeScreenCapture: boolean;
    displayRefreshRates: number[];
  }>();
  native.capabilities.mockReturnValue(capabilities.promise);
  setAppState("options", "videoFrameRate", 144);
  const shell = mountSettingsShell();
  shell.open();
  expect(appState.options.videoFrameRate).toBe(144);
  expect(shell.fallback).not.toHaveBeenCalled();
  capabilities.resolve({
    runtime: "desktop",
    nativeScreenCapture: true,
    displayRefreshRates: [120],
  });
  await waitFor(() =>
    expect(appState.options.videoFrameRate).toBe(120),
  );
  expect(shell.navigation).toBeInTheDocument();
});

it("hides native encoding if a desktop bundle is opened without native runtime support", async () => {
  native.capabilities.mockResolvedValue({
    runtime: "browser",
    nativeScreenCapture: true,
    displayRefreshRates: [144],
  });
  render(() => <MeetingSettings />);
  await waitFor(() =>
    expect(native.capabilities).toHaveBeenCalledOnce(),
  );
  expect(
    screen.queryByText(
      "setting.meeting_settings.native_encoder",
    ),
  ).toBeNull();
  expect(native.codecs).not.toHaveBeenCalled();
  const trigger = screen.getByRole("button", {
    name: /setting.meeting_settings.frame_rate/,
  });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(
    screen.queryByRole("option", { name: "144 FPS" }),
  ).toBeNull();
});

it("loads system frame rates in the standalone capture dialog without suspending it", async () => {
  native.capabilities.mockResolvedValue({
    runtime: "desktop",
    displayRefreshRates: [165],
  });
  render(() => (
    <Suspense fallback={<p>Loading whole dialog</p>}>
      <VideoCaptureSettings />
    </Suspense>
  ));
  expect(
    screen.queryByText("Loading whole dialog"),
  ).toBeNull();
  await choose(
    "setting.meeting_settings.frame_rate",
    "165 FPS",
  );
  expect(appState.options.videoFrameRate).toBe(165);
  expect(native.capabilities).toHaveBeenCalledOnce();
});

it("selects a supported encoder and codec together without changing browser preferences", async () => {
  setAppState("options", {
    nativeScreenCodec: "video/vp8",
    preferredVideoCodec: "video/vp9",
  });
  render(() => <MeetingSettings />);
  await choose(
    "setting.meeting_settings.native_encoder",
    "H.264 (GPU)",
  );
  expect(appState.options.nativeScreenEncoder).toBe(
    "mf:test",
  );
  expect(appState.options.nativeScreenCodec).toBe(
    "video/h264",
  );
  expect(
    screen.queryByText(
      "setting.meeting_settings.native_codec",
    ),
  ).toBeNull();
  const trigger = screen.getByRole("button", {
    name: /setting.meeting_settings.native_encoder/,
  });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(
    screen.queryByRole("option", {
      name: "VP8 (GPU)",
    }),
  ).toBeNull();
  expect(
    screen.getByRole("option", {
      name: "H.264 (GPU)",
    }),
  ).toBeInTheDocument();
  fireEvent.click(
    screen.getByRole("option", {
      name: "VP8",
    }),
  );
  expect(appState.options.nativeScreenEncoder).toBe(
    "software",
  );
  expect(appState.options.nativeScreenCodec).toBe(
    "video/vp8",
  );
  await choose(
    "setting.meeting_settings.native_encoder",
    "setting.meeting_settings.native_encoder_auto",
  );
  expect(appState.options.nativeScreenEncoder).toBe("auto");
  expect(appState.options.nativeScreenCodec).toBeNull();
  expect(appState.options.preferredVideoCodec).toBe(
    "video/vp9",
  );
});

it("selects encoding first, filters advanced colour choices and resets incompatible formats", async () => {
  render(() => <MeetingSettings />);
  const field = (name: string) =>
    screen.getByRole("button", {
      name: new RegExp(`setting.meeting_settings.${name}`),
    });
  await choose(
    "setting.meeting_settings.native_encoder",
    "H.265 (GPU)",
  );
  expect(
    screen.getByText(
      "setting.meeting_settings.native_advanced",
    ),
  ).toBeInTheDocument();
  expect(field("color_format")).toBeDisabled();
  expect(field("color_format")).toHaveTextContent(
    "YUV 4:2:0",
  );
  await choose(
    "setting.meeting_settings.native_encoder",
    "VP9",
  );
  await choose(
    "setting.meeting_settings.color_format",
    "RGB · 8-bit · SDR",
  );
  expect(
    nativeScreenOptions(appState.options),
  ).toMatchObject({
    encoder: "software",
    codec: "video/vp9",
    colorFormat: "rgb",
    colorRange: "full",
  });
  expect(field("native_encoder")).toBeEnabled();
  expect(field("color_matrix")).toHaveTextContent("RGB");
  expect(field("color_matrix")).toBeDisabled();
  expect(field("color_range")).toBeDisabled();
  await choose(
    "setting.meeting_settings.color_format",
    "YUV 4:4:4 · 8-bit · SDR",
  );
  expect(field("color_matrix")).toBeEnabled();
  expect(field("color_range")).toBeDisabled();
  await choose(
    "setting.meeting_settings.native_encoder",
    "H.265 (GPU)",
  );
  expect(appState.options.nativeColorFormat).toBe("yuv420");
  expect(
    nativeScreenOptions(appState.options),
  ).toMatchObject({
    encoder: "mf:test:h265",
    codec: "video/h265",
    colorFormat: "yuv420",
  });
  expect(field("color_format")).toBeDisabled();
  expect(field("color_range")).toBeEnabled();
  await choose(
    "setting.meeting_settings.native_encoder",
    "VP8",
  );
  expect(field("color_matrix")).toHaveTextContent("BT.601");
  expect(field("color_matrix")).toBeDisabled();
  expect(field("color_range")).toHaveTextContent(
    "setting.meeting_settings.color_range_limited",
  );
  expect(field("color_range")).toBeDisabled();
});

it("does not replace a saved hardware codec because of a stale RGB preference", async () => {
  setAppState("options", {
    nativeScreenCodec: "video/h265",
    nativeScreenEncoder: "mf:test:h265",
    nativeColorFormat: "rgb",
  });
  render(() => <MeetingSettings />);
  const encoder = await screen.findByRole("button", {
    name: /setting.meeting_settings.native_encoder/,
  });
  await waitFor(() => expect(encoder).toBeEnabled());
  expect(encoder).toHaveTextContent("H.265 (GPU)");
  expect(
    screen.getByRole("button", {
      name: /setting.meeting_settings.color_format/,
    }),
  ).toHaveTextContent("YUV 4:2:0");
  expect(appState.options.nativeScreenCodec).toBe(
    "video/h265",
  );
  expect(appState.options.nativeScreenEncoder).toBe(
    "mf:test:h265",
  );
});

it.each([
  [
    "auto",
    "video/h264",
    "H.264 (setting.meeting_settings.native_encoder_auto)",
  ],
  [
    "software",
    null,
    "setting.meeting_settings.stream.preferred_video_codec.auto (setting.meeting_settings.software)",
  ],
  [
    "mf:test",
    null,
    "setting.meeting_settings.stream.preferred_video_codec.auto (GPU)",
  ],
  ["mf:test", "video/h264", "H.264 (GPU)"],
  ["mf:test:h265", "video/h265", "H.265 (GPU)"],
] as const)(
  "preserves saved encoding %s / %s when opening settings",
  async (encoder, codec, name) => {
    setAppState("options", {
      nativeScreenEncoder: encoder,
      nativeScreenCodec: codec,
    });
    render(() => <MeetingSettings />);
    const trigger = await screen.findByRole("button", {
      name: /setting.meeting_settings.native_encoder/,
    });
    await waitFor(() => expect(trigger).not.toBeDisabled());
    expect(trigger).toHaveTextContent(name);
    expect(appState.options.nativeScreenEncoder).toBe(
      encoder,
    );
    expect(appState.options.nativeScreenCodec).toBe(codec);
  },
);

it.each([
  ["mf:removed", "video/h264"],
  ["mf:test", "video/vp8"],
])(
  "marks an unavailable saved combination %s / %s without silently replacing it",
  async (encoder, codec) => {
    setAppState("options", {
      nativeScreenEncoder: encoder,
      nativeScreenCodec: codec,
    });
    render(() => <MeetingSettings />);
    const trigger = await screen.findByRole("button", {
      name: /setting.meeting_settings.native_encoder/,
    });
    await waitFor(() => expect(trigger).not.toBeDisabled());
    expect(trigger).toHaveTextContent(
      "meeting.native_screen.unavailable",
    );
    expect(appState.options.nativeScreenEncoder).toBe(
      encoder,
    );
    expect(appState.options.nativeScreenCodec).toBe(codec);
    await waitFor(() => expect(trigger).not.toBeDisabled());
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(
      screen.getByRole("option", {
        name: /meeting.native_screen.unavailable/,
      }),
    ).toHaveAttribute("aria-disabled", "true");
    fireEvent.click(
      screen.getByRole("option", {
        name: "setting.meeting_settings.native_encoder_auto",
      }),
    );
    expect(appState.options.nativeScreenEncoder).toBe(
      "auto",
    );
    expect(appState.options.nativeScreenCodec).toBeNull();
  },
);

it("keeps screen and window capture backend preferences independent", async () => {
  render(() => <MeetingSettings />);
  await choose(
    "meeting.native_screen.screen_backend",
    "DXGI",
  );
  await choose(
    "meeting.native_screen.window_backend",
    "WGC",
  );
  expect(appState.options.nativeScreenCaptureBackend).toBe(
    "dxgi",
  );
  expect(appState.options.nativeWindowCaptureBackend).toBe(
    "wgc",
  );
  fireEvent.keyDown(
    screen.getByRole("button", {
      name: /meeting.native_screen.window_backend/,
    }),
    { key: "ArrowDown" },
  );
  expect(
    screen.queryByRole("option", { name: "DXGI" }),
  ).toBeNull();
});

it("selects probed HEVC hardware without offering unsupported HEVC software", async () => {
  render(() => <MeetingSettings />);
  await choose(
    "setting.meeting_settings.native_encoder",
    "H.265 (GPU)",
  );
  expect(appState.options.nativeScreenEncoder).toBe(
    "mf:test:h265",
  );
  expect(appState.options.nativeScreenCodec).toBe(
    "video/h265",
  );
  const trigger = screen.getByRole("button", {
    name: /setting.meeting_settings.native_encoder/,
  });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(
    screen.queryByRole("option", {
      name: "H.265",
    }),
  ).toBeNull();
});

it("saves audio codec, sample rate and channels independently and restores automatic defaults", async () => {
  render(() => <MeetingSettings />);
  await choose(
    "setting.meeting_settings.audio.codec.title",
    "Opus",
  );
  await choose(
    "setting.meeting_settings.audio.sample_rate.title",
    "48 kHz",
  );
  await choose(
    "setting.meeting_settings.audio.channels.title",
    "setting.meeting_settings.audio.channels.mono",
  );
  expect(appState.options.preferredAudioCodec).toBe(
    "audio/opus",
  );
  expect(appState.options.audioSampleRate).toBe(48000);
  expect(appState.options.audioChannelCount).toBe(1);
  expect(appState.options.preferredVideoCodec).toBeNull();
  cleanup();
  render(() => <MeetingSettings />);
  expect(
    screen.getByRole("button", {
      name: /audio.sample_rate.title/,
    }),
  ).toHaveTextContent("48 kHz");
  for (const name of ["codec", "sample_rate", "channels"]) {
    await choose(
      `setting.meeting_settings.audio.${name}.title`,
      "setting.meeting_settings.audio.auto",
    );
  }
  expect(appState.options.preferredAudioCodec).toBeNull();
  expect(appState.options.audioSampleRate).toBeNull();
  expect(appState.options.audioChannelCount).toBeNull();
});

it("discovers native audio codecs separately from video capabilities", async () => {
  native.codecs.mockImplementation(async (kind?: string) =>
    kind === "audio"
      ? [
          "audio/opus",
          "audio/PCMA",
          "audio/red",
          "audio/CN",
        ]
      : ["video/h264"],
  );
  render(() => <MeetingSettings />);
  await waitFor(() =>
    expect(native.codecs).toHaveBeenCalledWith("audio"),
  );
  await choose(
    "setting.meeting_settings.native_audio_codec",
    "G.711 A-law (PCMA)",
  );
  expect(appState.options.nativeAudioCodec).toBe(
    "audio/pcma",
  );
  expect(appState.options.preferredAudioCodec).toBeNull();
  await choose(
    "setting.meeting_settings.audio.codec.title",
    "Opus",
  );
  expect(appState.options.preferredAudioCodec).toBe(
    "audio/opus",
  );
  expect(appState.options.nativeAudioCodec).toBe(
    "audio/pcma",
  );
  const trigger = screen.getByRole("button", {
    name: /setting.meeting_settings.audio.codec.title/,
  });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(
    screen.queryByRole("option", {
      name: "G.711 A-law (PCMA)",
    }),
  ).toBeNull();
});

it("keeps an unavailable saved audio codec visible without overwriting it", async () => {
  native.kind = "browser";
  setAppState(
    "options",
    "preferredAudioCodec",
    "audio/pcma",
  );
  render(() => <MeetingSettings />);
  const trigger = screen.getByRole("button", {
    name: /audio.codec.title/,
  });
  expect(trigger).toHaveTextContent(
    "G.711 A-law (PCMA) (setting.meeting_settings.audio.unavailable)",
  );
  await waitFor(() => expect(trigger).not.toBeDisabled());
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  expect(
    screen.getByRole("option", {
      name: /audio.unavailable/,
    }),
  ).toHaveAttribute("aria-disabled", "true");
  expect(appState.options.preferredAudioCodec).toBe(
    "audio/pcma",
  );
});

it("leaves audio preferences usable when capability discovery is unavailable", async () => {
  vi.stubGlobal("RTCRtpSender", undefined);
  native.codecs.mockRejectedValue(new Error("Unavailable"));
  render(() => <MeetingSettings />);
  expect(
    screen.getAllByText(
      "setting.meeting_settings.audio.codec.unsupported",
    )[0],
  ).toBeInTheDocument();
  await choose(
    "setting.meeting_settings.audio.sample_rate.title",
    "16 kHz",
  );
  expect(appState.options.audioSampleRate).toBe(16000);
});
