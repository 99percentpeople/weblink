// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
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
      : key === "video.statistics.slowest_receiver"
        ? `${key}: ${args?.peer}`
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

const visibleStatistics = () =>
  within(screen.getByRole("group"));

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
    "video.statistics.send · PC\nvideo.statistics.encode_frame_rate 60.0 FPS\nvideo.statistics.bitrate 110.0 Mbps",
  );
  expect(text).toContain("video.statistics.preview");
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

it("merges local preview and presentation in details while copying both original snapshots", async () => {
  fixture.rows = () => [
    {
      direction: "receive",
      preview: true,
      fps: 60,
      implementation: "raw-preview",
      counters: {
        current: {
          id: "preview",
          timestamp: 1000,
          frames: 60,
        },
      },
    },
    {
      direction: "display",
      preview: true,
      fps: 59,
      onePercentLowFps: 45,
      submitMs: 0.2,
      presentationQueueMs: 1,
    },
    {
      direction: "send",
      peer: "Alice",
      captureToEncodeMs: 8,
      encodeMs: 3,
      sendDelayMs: 2,
      sendLatencyMs: 10,
      sendLatencyBasis: "capture",
      bitrate: 4_000_000,
      history: [
        { at: 1000, sendLatencyMs: 8 },
        { at: 2000, sendLatencyMs: 10 },
      ],
    },
  ];
  fixture.copy.mockResolvedValue(true);
  render(() => (
    <VideoStatisticsOverlay read={async () => []} />
  ));
  expect(
    screen
      .getAllByRole("term")
      .map((term) => term.textContent),
  ).toEqual([
    "video.statistics.send_latency",
    "video.statistics.frame_rate",
    "video.statistics.total_bitrate",
  ]);
  expect(
    visibleStatistics().getByText("10.0 ms"),
  ).toBeTruthy();
  expect(
    screen.getByRole("img", {
      name: "video.statistics.send_latency · 60 · 10.0 ms",
    }),
  ).toBeTruthy();
  for (const value of [
    "0.2 ms",
    "8.0 ms",
    "3.0 ms",
    "2.0 ms",
  ])
    expect(
      visibleStatistics().queryByText(value),
    ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.show_details",
    }),
  );
  expect(
    visibleStatistics().getAllByText(
      "video.statistics.preview",
    ),
  ).toHaveLength(1);
  expect(
    visibleStatistics().getAllByText("59.0 FPS"),
  ).toHaveLength(1);
  expect(
    visibleStatistics().queryByText("60.0 FPS"),
  ).toBeNull();
  expect(
    visibleStatistics().getByText("0.2 ms"),
  ).toBeTruthy();
  expect(
    visibleStatistics().getByText("10.0 ms"),
  ).toBeTruthy();
  for (const value of ["8.0 ms", "3.0 ms", "2.0 ms"])
    expect(
      visibleStatistics().queryByText(value),
    ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.copy",
    }),
  );
  await waitFor(() =>
    expect(fixture.copy).toHaveBeenCalledOnce(),
  );
  const text = fixture.copy.mock.calls[0][0] as string;
  expect(text).toContain('"direction": "receive"');
  expect(text).toContain('"direction": "display"');
  expect(text).toContain('"frames": 60');
  expect(text).toContain(
    "video.statistics.submit_latency_description 0.2 ms",
  );
  expect(text).toContain(
    "video.statistics.send_latency_description 10.0 ms",
  );
  expect(text).toContain(
    "video.statistics.capture_to_encode_description 8.0 ms",
  );
  expect(text).toContain(
    "video.statistics.encode_latency_description 3.0 ms",
  );
  expect(text).toContain(
    "video.statistics.send_queue 2.0 ms",
  );
  expect(text).toContain('"sendLatencyBasis": "capture"');
});

it("summarizes multiple receivers, identifies the slowest and keeps their expanded metrics separate", async () => {
  const [rows, setRows] = createSignal<
    VideoStatisticsRow[]
  >([
    { direction: "display", preview: true, fps: 59 },
    {
      direction: "send",
      peer: "Laptop",
      sendLatencyMs: 6,
      sendLatencyBasis: "encode",
      fps: 60,
      bitrate: 2_000_000,
    },
    {
      direction: "send",
      peer: "Phone",
      sendLatencyMs: 12,
      sendLatencyBasis: "encode",
      fps: 30,
      bitrate: 4_000_000,
    },
  ]);
  fixture.rows = rows;
  fixture.copy.mockResolvedValue(true);
  render(() => (
    <VideoStatisticsOverlay read={async () => []} />
  ));
  expect(
    screen
      .getAllByRole("term")
      .map((term) => term.textContent),
  ).toEqual([
    "video.statistics.send_latency",
    "video.statistics.frame_rate",
    "video.statistics.total_bitrate",
  ]);
  for (const value of ["12.0 ms", "59.0 FPS", "6.0 Mbps"])
    expect(
      visibleStatistics().getByText(value),
    ).toBeTruthy();
  expect(
    screen.getByTitle(
      "video.statistics.slowest_receiver: Phone\nvideo.statistics.send_latency_partial_description",
      { normalizer: (value) => value },
    ),
  ).toBeTruthy();

  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.show_details",
    }),
  );
  for (const [peer, latency, fps, bitrate] of [
    ["Laptop", "6.0 ms", "60.0 FPS", "2.0 Mbps"],
    ["Phone", "12.0 ms", "30.0 FPS", "4.0 Mbps"],
  ]) {
    const group = within(
      screen.getByRole("region", {
        name: `video.statistics.send · ${peer}`,
      }),
    );
    for (const value of [latency, fps, bitrate])
      expect(group.getByText(value)).toBeTruthy();
  }
  expect(
    visibleStatistics().queryByText("6.0 Mbps"),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.copy",
    }),
  );
  await waitFor(() =>
    expect(fixture.copy).toHaveBeenCalledOnce(),
  );
  const copied = fixture.copy.mock.calls[0][0];
  expect(copied).toContain('"peer": "Laptop"');
  expect(copied).toContain('"peer": "Phone"');
  expect(copied).toContain(
    "video.statistics.bitrate 2.0 Mbps",
  );
  expect(copied).toContain(
    "video.statistics.bitrate 4.0 Mbps",
  );

  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.hide_details",
    }),
  );
  setRows(
    [...rows()].reverse().map((row) =>
      row.peer === "Laptop"
        ? {
            ...row,
            sendLatencyMs: 20,
            bitrate: 6_000_000,
          }
        : row,
    ),
  );
  expect(
    screen.getByTitle(
      "video.statistics.slowest_receiver: Laptop\nvideo.statistics.send_latency_partial_description",
      { normalizer: (value) => value },
    ),
  ).toBeTruthy();
  expect(
    visibleStatistics().getByText("20.0 ms"),
  ).toBeTruthy();
  expect(
    visibleStatistics().getByText("10.0 Mbps"),
  ).toBeTruthy();
  expect(
    visibleStatistics().getByText("59.0 FPS"),
  ).toBeTruthy();
  setRows(rows().filter((row) => row.peer !== "Laptop"));
  expect(
    visibleStatistics().getByText("12.0 ms"),
  ).toBeTruthy();
  expect(
    visibleStatistics().getByText("4.0 Mbps"),
  ).toBeTruthy();
});

it("shows receive latency details only after expanding, even without end-to-end data", () => {
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
      receiveToDecodeMs: 20,
      roundTripMs: 10,
      jitterMs: 8,
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
    "video.statistics.frame_rate",
    "video.statistics.bitrate",
  ]);
  expect(
    visibleStatistics().queryByText("20.0 ms"),
  ).toBeNull();
  expect(
    visibleStatistics().getByText("59.0 FPS"),
  ).toBeTruthy();
  expect(
    visibleStatistics().queryByText("45.0 FPS"),
  ).toBeNull();
  expect(
    visibleStatistics().queryByText("60.0 FPS"),
  ).toBeNull();
  expect(
    visibleStatistics().queryByText("5.0 Mbps"),
  ).toBeNull();
  expect(
    visibleStatistics().queryByText("2.0 /s"),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.show_details",
    }),
  );
  for (const value of ["10.0 ms", "30.0 ms"])
    expect(
      visibleStatistics().getByText(value),
    ).toBeTruthy();
  expect(
    visibleStatistics().getByText("45.0 FPS"),
  ).toBeTruthy();
  expect(
    visibleStatistics().getAllByText("60.0 FPS"),
  ).toHaveLength(1);
  expect(
    visibleStatistics().getByText("59.0 FPS"),
  ).toBeTruthy();
  expect(
    visibleStatistics().getByText("5.0 Mbps"),
  ).toBeTruthy();
  expect(
    visibleStatistics().queryByText("2.0 /s"),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.hide_details",
    }),
  );
  expect(
    screen
      .getAllByRole("term")
      .map((term) => term.textContent),
  ).toEqual([
    "video.statistics.frame_rate",
    "video.statistics.bitrate",
  ]);
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
  expect(
    visibleStatistics().queryByText("2.0 ms"),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.show_details",
    }),
  );
  expect(
    visibleStatistics().queryByText("2.0 ms"),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.hide_details",
    }),
  );
  expect(
    visibleStatistics().queryByText("2.0 ms"),
  ).toBeNull();
  expect(
    visibleStatistics().getByText("60.0 FPS"),
  ).toBeTruthy();
  setRows([{ ...rows()[0], fps: 59, decodeMs: 3 }]);
  expect(
    screen.getByRole("region", {
      name: "video.statistics.title",
    }),
  ).toBe(window);
  expect(
    visibleStatistics().getByText("59.0 FPS"),
  ).toBeTruthy();
  expect(
    visibleStatistics().queryByText("3.0 ms"),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.copy",
    }),
  );
  await waitFor(() =>
    expect(fixture.copy).toHaveBeenCalledOnce(),
  );
  expect(fixture.copy.mock.calls[0][0]).toContain(
    "video.statistics.decode_time_description 3.0 ms",
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.show_details",
    }),
  );
  expect(
    visibleStatistics().queryByText("3.0 ms"),
  ).toBeNull();
});

it("shows the total latency in compact mode and preserves stage timings in details and exports", async () => {
  const [rows, setRows] = createSignal<
    VideoStatisticsRow[]
  >([
    {
      direction: "receive",
      peer: "Alice",
      roundTripMs: 10,
      receiveToDecodeMs: 20,
      jitterMs: 5,
      fps: 60,
      decodeMs: 2,
      bitrate: 7_000_000,
      implementation: "diagnostic-decoder",
    },
    {
      direction: "display",
      fps: 59,
      onePercentLowFps: 40,
      endToEndMs: 80,
      endToEndState: "estimated",
      captureToReceiveMs: 55,
      presentationQueueMs: 1,
      receiveToPresentMs: 25,
      droppedPerSecond: 3,
      history: [{ at: 1000, endToEndMs: 80 }],
    },
  ]);
  fixture.rows = rows;
  fixture.copy.mockResolvedValue(true);
  render(() => (
    <VideoStatisticsOverlay read={async () => []} />
  ));
  expect(
    screen
      .getAllByRole("term")
      .map((term) => term.textContent),
  ).toEqual([
    "video.statistics.end_to_end",
    "video.statistics.frame_rate",
    "video.statistics.bitrate",
  ]);
  expect(
    visibleStatistics().getByText("80.0 ms"),
  ).toBeTruthy();
  expect(
    visibleStatistics().getByText("7.0 Mbps"),
  ).toBeTruthy();
  expect(
    visibleStatistics().queryByText("40.0 FPS"),
  ).toBeNull();
  for (const value of ["10.0 ms", "20.0 ms", "5.0 ms"])
    expect(
      visibleStatistics().queryByText(value),
    ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.show_details",
    }),
  );
  expect(
    screen
      .getAllByRole("term")
      .map((term) => term.textContent),
  ).toEqual([
    "video.statistics.end_to_end",
    "video.statistics.capture_to_receive",
    "video.statistics.receive_to_present",
    "video.statistics.rtt",
    "video.statistics.frame_rate",
    "video.statistics.one_percent_low_short",
    "video.statistics.bitrate",
  ]);
  expect(
    visibleStatistics().getByText("7.0 Mbps"),
  ).toBeTruthy();
  expect(
    visibleStatistics().queryByText("diagnostic-decoder"),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.copy",
    }),
  );
  await waitFor(() =>
    expect(fixture.copy).toHaveBeenCalledOnce(),
  );
  const text = fixture.copy.mock.calls[0][0] as string;
  expect(text).toContain(
    "video.statistics.end_to_end_description 80.0 ms",
  );
  expect(text).toContain(
    "video.statistics.rtt_description 10.0 ms",
  );
  expect(text).toContain(
    "video.statistics.receive_to_decode_description 20.0 ms",
  );
  expect(text).toContain(
    "video.statistics.buffer_description 5.0 ms",
  );
  expect(text).toContain(
    "video.statistics.presentation_queue_description 1.0 ms",
  );
  expect(text).toContain(
    "video.statistics.decode_time_description 2.0 ms",
  );
  expect(text).toContain(
    "video.statistics.decode_frame_rate 60.0 FPS",
  );
  expect(text).toContain(
    "video.statistics.player_dropped 3.0 /s",
  );
  expect(text).toContain("diagnostic-decoder");
  expect(text).toContain('"endToEndState": "estimated"');
  setRows([
    rows()[0],
    {
      ...rows()[1],
      endToEndMs: undefined,
      endToEndState: undefined,
      history: [...rows()[1].history!, { at: 2000 }],
    },
  ]);
  expect(
    visibleStatistics().queryByText(
      "video.statistics.end_to_end",
    ),
  ).toBeNull();
  fireEvent.click(
    screen.getByRole("button", {
      name: "video.statistics.hide_details",
    }),
  );
  expect(
    visibleStatistics().queryByText(
      "video.statistics.end_to_end",
    ),
  ).toBeNull();
  expect(
    visibleStatistics().queryByText("80.0 ms"),
  ).toBeNull();
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

it("formats estimates as plain values and keeps unavailable metrics distinct from zero", () => {
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
      receiveToDecodeMs: 0,
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
  expect(
    visibleStatistics().getByText("72.4 FPS"),
  ).toBeTruthy();
  expect(
    visibleStatistics().queryByText(
      "video.statistics.low_unavailable",
    ),
  ).toBeNull();
  expect(
    visibleStatistics().getByText("0.0 ms"),
  ).toBeTruthy();
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
      name: "video.statistics.decode_frame_rate · 60 · 60.0 FPS",
    }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("img", {
      name: "video.statistics.receive_to_decode · 60 · 22.0 ms",
    }),
  ).toBeNull();
  expect(
    screen.getByRole("img", {
      name: "video.statistics.bitrate · 60 · 5.0 Mbps",
    }),
  ).toBeTruthy();
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
  expect(
    visibleStatistics().getAllByText("—"),
  ).toHaveLength(1);
  expect(
    screen.getByRole("img", {
      name: "video.statistics.decode_frame_rate · 60 · 60.0 FPS",
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
  expect(
    screen.getByRole("img", {
      name: "video.statistics.receive_to_decode · 60 · 22.0 ms",
    }),
  ).toBeTruthy();
});
