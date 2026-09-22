import { describe, expect, it, vi } from "vitest";
import { getVisibleVideoDisplayTracks } from "@/routes/video/components/video-display-tracks";

const makeTrack = (
  id: string,
  kind: "audio" | "video",
  settings: MediaTrackSettings = {},
) =>
  ({
    id,
    kind,
    label: kind,
    readyState: "live",
    getSettings: vi.fn(() => settings),
  }) as unknown as MediaStreamTrack;

describe("video display track selection", () => {
  it("keeps a real Firefox video track even when initial settings are zero-sized", () => {
    const video = makeTrack("video", "video", {
      width: 0,
      height: 0,
      frameRate: 0,
    });

    expect(
      getVisibleVideoDisplayTracks([video], false),
    ).toEqual([video]);
    expect(video.getSettings).not.toHaveBeenCalled();
  });

  it("hides video only when the protocol explicitly marks the stream as placeholder", () => {
    const audio = makeTrack("audio", "audio");
    const video = makeTrack("video", "video", {
      width: 1920,
      height: 1080,
      frameRate: 60,
    });

    expect(
      getVisibleVideoDisplayTracks([audio, video], true),
    ).toEqual([audio]);
  });
});
