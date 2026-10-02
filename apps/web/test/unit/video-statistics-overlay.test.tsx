// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { VideoStatisticsOverlay } from "@/routes/home/components/video-statistics-overlay";

const fixture = vi.hoisted(() => ({
  copy: vi.fn(),
  success: vi.fn(),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
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
  createVideoStatistics: () => () => [
    {
      direction: "send",
      peer: "Phone",
      codec: "video/H264",
      bitrate: 5_000_000,
      targetBitrate: 6_000_000,
      encoderBitrate: 5_800_000,
      availableOutgoingBitrate: 7_000_000,
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
      droppedPerSecond: 0,
    },
  ],
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
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
    "video.statistics.send · PC\nvideo.statistics.encode 60.0 FPS · 110.0 Mbps",
  );
  expect(text).toContain(
    "video.statistics.display · video.statistics.preview",
  );
  expect(click).not.toHaveBeenCalled();
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
