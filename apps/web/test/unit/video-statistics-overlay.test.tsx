// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import type { VideoStatisticsRow } from "@/libs/hooks/video-statistics";
import { VideoStatisticsOverlay } from "@/routes/home/components/video-statistics-overlay";

const fixture = vi.hoisted(() => ({
  copy: vi.fn(),
  success: vi.fn(),
  rows: undefined as
    | (() => VideoStatisticsRow[])
    | undefined,
}));
vi.mock("@/i18n", () => ({
  t: (key: string, args?: Record<string, unknown>) =>
    key === "video.statistics.trend"
      ? `${args?.metric} · ${args?.seconds} · ${args?.maximum}`
      : key,
}));
vi.mock("solid-sonner", () => ({
  toast: { success: fixture.success },
}));
vi.mock("@/libs/utils/copy-text", () => ({
  copyText: fixture.copy,
}));
vi.mock(
  "@/routes/home/components/video-display-context",
  () => ({
    useVideoDisplay: () => ({
      videoTrack: () => ({}),
      videoRef: () => null,
    }),
  }),
);
vi.mock("@/libs/hooks/video-statistics", () => ({
  createVideoStatistics: () => () =>
    fixture.rows?.() ?? [
      {
        direction: "send",
        peer: "Phone",
        codec: "video/H264",
        bitrate: 5_000_000,
        targetBitrate: 6_000_000,
        encoderBitrate: 5_800_000,
        availableOutgoingBitrate: 7_000_000,
        counters: {
          current: {
            id: "native",
            timestamp: 2000,
            captureFrames: 120,
            replacedInputs: 2,
            rateLimitedInputs: 4,
          },
          previous: {
            id: "native",
            timestamp: 1000,
            captureFrames: 60,
            replacedInputs: 1,
            rateLimitedInputs: 3,
          },
        },
      },
      {
        direction: "send",
        peer: "PC",
        bitrate: 110_000_000,
        fps: 60,
      },
      {
        direction: "display",
        preview: true,
        fps: 120,
        onePercentLowFps: 72.4,
        droppedPerSecond: 0,
      },
    ],
}));
beforeEach(() => {
  fixture.rows = undefined;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("copies every peer's complete snapshot without triggering the video action", async () => {
  fixture.copy.mockResolvedValue(true);
  const click = vi.fn();
  render(() => (
    <div onClick={click}>
      <VideoStatisticsOverlay read={async () => []} />
    </div>
  ));
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.copy",
    }),
  );
  await waitFor(() =>
    expect(fixture.success).toHaveBeenCalledOnce(),
  );
  const text = fixture.copy.mock.calls[0][0];
  expect(text).toContain(
    "video.statistics.send · Phone\nH264",
  );
  expect(text).toContain(
    "video.statistics.target_bitrate 6.0 Mbps",
  );
  expect(text).toContain(
    "video.statistics.encoder_bitrate 5.8 Mbps",
  );
  expect(text).toContain(
    "video.statistics.bandwidth_estimate 7.0 Mbps",
  );
  expect(text).toContain(
    "video.statistics.send · PC\nvideo.statistics.encode 60.0 FPS\nvideo.statistics.bitrate 110.0 Mbps",
  );
  expect(text).toContain(
    "video.statistics.display · video.statistics.preview",
  );
  expect(click).not.toHaveBeenCalled();
  expect(text).toContain(
    "video.statistics.one_percent_low 72.4 FPS",
  );
  expect(text).toContain('"captureFrames": 120');
  expect(text).toContain('"rateLimitedInputs": 4');
  expect(text).toContain('"previous"');
});

it("does not report success when clipboard copying is unavailable", async () => {
  fixture.copy.mockResolvedValue(false);
  render(() => (
    <VideoStatisticsOverlay read={async () => []} />
  ));
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.copy",
    }),
  );
  await waitFor(() =>
    expect(fixture.copy).toHaveBeenCalledOnce(),
  );
  expect(fixture.success).not.toHaveBeenCalled();
});

it("shows one playback overview until per-stream details are requested", () => {
  fixture.rows = () => [
    {
      direction: "send",
      peer: "PC",
      fps: 60,
      bitrate: 5_000_000,
    },
    {
      direction: "receive",
      peer: "Phone",
      fps: 60,
      decodeMs: 4,
    },
    {
      direction: "display",
      receiveToPresentMs: 30,
      fps: 59,
      onePercentLowFps: 45,
      droppedPerSecond: 2,
    },
  ];
  render(() => (
    <VideoStatisticsOverlay read={async () => []} />
  ));
  expect(
    screen
      .getAllByRole("term")
      .map((term) => term.textContent),
  ).toEqual([
    "video.statistics.receive_to_present",
    "video.statistics.frame_rate",
    "video.statistics.one_percent_low_short",
  ]);
  expect(screen.getByText("30.0 ms")).toBeTruthy();
  expect(screen.getByText("59.0 FPS")).toBeTruthy();
  expect(screen.getByText("45.0 FPS")).toBeTruthy();
  expect(screen.queryByText("60.0 FPS")).toBeNull();
  expect(screen.queryByText("5.0 Mbps")).toBeNull();
  expect(screen.queryByText("2.0 /s")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.show_details",
    }),
  );
  expect(screen.getAllByText("60.0 FPS")).toHaveLength(2);
  expect(screen.getByText("59.0 FPS")).toBeTruthy();
  expect(screen.getByText("5.0 Mbps")).toBeTruthy();
  expect(screen.getByText("2.0 /s")).toBeTruthy();
});

it("keeps the window and compact mode across live updates while copying all details", async () => {
  const [rows, setRows] = createSignal<
    VideoStatisticsRow[]
  >([
    {
      direction: "receive",
      peer: "Phone",
      fps: 60,
      bitrate: 5_000_000,
      decodeMs: 2,
    },
  ]);
  fixture.rows = rows;
  fixture.copy.mockResolvedValue(true);
  render(() => (
    <VideoStatisticsOverlay read={async () => []} />
  ));
  const window = screen.getByRole("region", {
    name: "video.statistics.title",
  });
  expect(screen.queryByText("2.0 ms")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.show_details",
    }),
  );
  expect(screen.getByText("2.0 ms")).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.hide_details",
    }),
  );
  expect(screen.queryByText("2.0 ms")).toBeNull();
  expect(screen.getByText("60.0 FPS")).toBeTruthy();
  setRows([{ ...rows()[0], fps: 59, decodeMs: 3 }]);
  expect(
    screen.getByRole("region", {
      name: "video.statistics.title",
    }),
  ).toBe(window);
  expect(screen.getByText("59.0 FPS")).toBeTruthy();
  expect(screen.queryByText("3.0 ms")).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.copy",
    }),
  );
  await waitFor(() =>
    expect(fixture.copy).toHaveBeenCalledOnce(),
  );
  expect(fixture.copy.mock.calls[0][0]).toContain(
    "video.statistics.decode 3.0 ms",
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.show_details",
    }),
  );
  expect(screen.getByText("3.0 ms")).toBeTruthy();
});

it("keeps an empty window usable while statistics recover", () => {
  const [rows, setRows] = createSignal<
    VideoStatisticsRow[]
  >([]);
  fixture.rows = rows;
  render(() => (
    <VideoStatisticsOverlay read={async () => []} />
  ));
  const window = screen.getByRole("region", {
    name: "video.statistics.title",
  });
  const copy = screen.getByRole("button", {
    name: "video.statistics.copy",
  }) as HTMLButtonElement;
  expect(copy.disabled).toBe(true);
  expect(
    screen.getByText("video.statistics.waiting"),
  ).toBeTruthy();
  setRows([{ direction: "display", fps: 30 }]);
  expect(copy.disabled).toBe(false);
  expect(
    screen.getByRole("region", {
      name: "video.statistics.title",
    }),
  ).toBe(window);
  expect(
    screen.queryByText("video.statistics.waiting"),
  ).toBeNull();
});

it.each(["button", "Escape"])(
  "closes through %s without forwarding panel input to the video",
  (method) => {
    const forwarded = vi.fn();
    const [shown, setShown] = createSignal(true);
    render(() => (
      <div
        onClick={forwarded}
        onPointerDown={forwarded}
        onPointerMove={forwarded}
        onPointerUp={forwarded}
        onWheel={forwarded}
        onKeyDown={forwarded}
        onKeyUp={forwarded}
      >
        <Show when={shown()}>
          <VideoStatisticsOverlay
            read={async () => []}
            onClose={() => setShown(false)}
          />
        </Show>
      </div>
    ));
    const handle = screen.getByRole("button", {
      name: "video.statistics.move",
    });
    fireEvent.pointerDown(handle);
    fireEvent.pointerMove(handle);
    fireEvent.pointerUp(handle);
    fireEvent.wheel(handle);
    expect(
      fireEvent.keyDown(handle, { key: "ArrowRight" }),
    ).toBe(false);
    fireEvent.keyUp(handle, { key: "ArrowRight" });
    if (method === "button")
      fireEvent.click(
        screen.getByRole("button", {
          name: "common.action.close",
        }),
      );
    else fireEvent.keyDown(handle, { key: "Escape" });
    expect(
      screen.queryByRole("region", {
        name: "video.statistics.title",
      }),
    ).toBeNull();
    expect(forwarded).not.toHaveBeenCalled();
  },
);

it("distinguishes estimated, unsupported and unavailable metrics from measured zero", () => {
  fixture.rows = () => [
    {
      direction: "display",
      onePercentLowFps: 72.4,
      onePercentLowState: "estimated",
    },
    {
      direction: "receive",
      fps: Number.NaN,
      bitrate: Infinity,
      targetBitrate: -1,
      decodeMs: 0,
      onePercentLowState: "unsupported",
    },
  ];
  const view = render(() => (
    <VideoStatisticsOverlay read={async () => []} />
  ));
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.show_details",
    }),
  );
  expect(screen.getByText("≈ 72.4 FPS")).toBeTruthy();
  expect(
    screen.getByText("video.statistics.low_unavailable"),
  ).toBeTruthy();
  expect(screen.getByText("0.0 ms")).toBeTruthy();
  expect(view.container.textContent).not.toMatch(
    /NaN|Infinity|-1\.0|0\.0 FPS/,
  );
});

it("shows labeled trends with current units and copies history while details are collapsed", async () => {
  const [rows, setRows] = createSignal<
    VideoStatisticsRow[]
  >([
    {
      direction: "receive",
      fps: 60,
      bitrate: 5_000_000,
      receiveToDecodeMs: 22,
      history: [
        {
          at: 1000,
          fps: 30,
          bitrate: 4_000_000,
          receiveToDecodeMs: 20,
        },
        {
          at: 2000,
          fps: 60,
          bitrate: 5_000_000,
          receiveToDecodeMs: 22,
        },
      ],
    },
  ]);
  fixture.rows = rows;
  fixture.copy.mockResolvedValue(true);
  render(() => (
    <VideoStatisticsOverlay read={async () => []} />
  ));
  expect(
    screen.getByRole("img", {
      name: "video.statistics.decode · 60 · 60.0 FPS",
    }),
  ).toBeTruthy();
  expect(
    screen.getByRole("img", {
      name: "video.statistics.receive_to_decode · 60 · 22.0 ms",
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("img", {
      name: "video.statistics.bitrate · 60 · 5.0 Mbps",
    }),
  ).toBeNull();
  setRows([
    {
      ...rows()[0],
      fps: undefined,
      history: [
        ...rows()[0].history!,
        {
          at: 3000,
          bitrate: 5_000_000,
          receiveToDecodeMs: 22,
        },
      ],
    },
  ]);
  expect(screen.getAllByText("—")).toHaveLength(2);
  expect(
    screen.getByRole("img", {
      name: "video.statistics.decode · 60 · 60.0 FPS",
    }),
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.copy",
    }),
  );
  await waitFor(() =>
    expect(fixture.copy).toHaveBeenCalledOnce(),
  );
  expect(fixture.copy.mock.calls[0][0]).toContain(
    '"history"',
  );
  expect(fixture.copy.mock.calls[0][0]).toContain(
    '"at": 3000',
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.show_details",
    }),
  );
  expect(
    screen.getByRole("img", {
      name: "video.statistics.bitrate · 60 · 5.0 Mbps",
    }),
  ).toBeTruthy();
});
