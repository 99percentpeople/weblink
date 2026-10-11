import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  browserDecodeCapabilities,
  commonCodecs,
  MediaCodecPeers,
} from "@/libs/domain/media-codecs";
import {
  parseMediaDecodeCapabilities,
  type MediaDecodeCapabilities,
} from "@/libs/domain/protocol/media-codecs";
import { createNativeCodecSelection } from "@/libs/application/native-codec-selection";
import type { NativeScreenShare } from "@weblink/platform";

const receiver = (
  ...video: string[]
): MediaDecodeCapabilities => ({
  video,
  audio: ["audio/opus", "audio/pcma"],
});
afterEach(() => vi.unstubAllGlobals());
describe("common media codecs", () => {
  it("advertises decoders independently of the browser's encoders, excluding RTP repair codecs", () => {
    vi.stubGlobal("RTCRtpSender", {
      getCapabilities: () => ({
        codecs: [{ mimeType: "video/H264" }],
      }),
    });
    vi.stubGlobal("RTCRtpReceiver", {
      getCapabilities: (kind: string) => ({
        codecs: (kind === "video"
          ? [
              "video/H265",
              "video/H264",
              "video/rtx",
              "video/H265",
            ]
          : ["audio/opus", "audio/red"]
        ).map((mimeType) => ({ mimeType })),
      }),
    });
    expect(browserDecodeCapabilities()).toEqual({
      video: ["video/h265", "video/h264"],
      audio: ["audio/opus"],
    });
    vi.stubGlobal("RTCRtpReceiver", undefined);
    expect(browserDecodeCapabilities()).toEqual({
      video: null,
      audio: null,
    });
  });
  it("bounds and validates the additive capability without trusting malformed hello fields", () => {
    expect(
      parseMediaDecodeCapabilities({
        video: ["video/H264", "video/h264"],
        audio: null,
      }),
    ).toEqual({ video: ["video/h264"], audio: null });
    for (const value of [
      null,
      {},
      { video: [], audio: [1] },
      { video: Array(33).fill("video/h264"), audio: [] },
      { video: ["audio/opus"], audio: [] },
    ])
      expect(
        parseMediaDecodeCapabilities(value),
      ).toBeUndefined();
    expect(
      parseMediaDecodeCapabilities({
        video: [],
        audio: [],
      }),
    ).toEqual({ video: [], audio: [] });
  });
  it("downgrades for joining/unknown peers, upgrades on leave and deduplicates repeat reports", () => {
    const peers = new MediaCodecPeers();
    const local = ["video/h265", "video/h264", "video/vp8"];
    const selected = () =>
      commonCodecs("video", local, peers.receivers());
    expect(selected()[0]).toBe("video/h264");
    const modern = receiver("video/h265", "video/h264");
    expect(peers.set("modern", modern)).toBe(true);
    expect(selected()).toEqual([
      "video/h265",
      "video/h264",
    ]);
    expect(peers.set("modern", modern)).toBe(false);
    peers.set("old");
    expect(selected()).toEqual(["video/h264"]);
    peers.set("old", receiver("video/vp8"));
    expect(selected()).toEqual([]);
    peers.delete("old");
    expect(selected()[0]).toBe("video/h265");
  });
  it("prefers native hardware before compression efficiency and chooses common audio", () => {
    const local = ["video/av1", "video/h265", "video/h264"];
    expect(
      commonCodecs(
        "video",
        local,
        [receiver(...local)],
        ["video/h264"],
      )[0],
    ).toBe("video/h264");
    expect(
      commonCodecs(
        "video",
        local,
        [receiver(...local)],
        ["video/h264", "video/h265"],
      )[0],
    ).toBe("video/h265");
    expect(
      commonCodecs(
        "audio",
        ["audio/opus", "audio/pcma"],
        [{ video: [], audio: ["audio/pcma"] }],
      ),
    ).toEqual(["audio/pcma"]);
  });
});

const share = () =>
  ({
    encoders: async () => [
      {
        id: "software",
        hardware: false,
        codecs: ["video/vp8", "video/av1"],
      },
      {
        id: "mf:264",
        hardware: true,
        codecs: ["video/h264"],
      },
      {
        id: "mf:265",
        hardware: true,
        codecs: ["video/h265"],
      },
    ],
    codecs: async () => ["audio/opus", "audio/pcma"],
  }) as unknown as NativeScreenShare;

describe("native publication selection", () => {
  it("changes every subscribed sender only when the resolved format changes and releases subscriptions", async () => {
    const selection = await createNativeCodecSelection(
      share(),
      { audio: true },
    );
    const first = vi.fn(),
      second = vi.fn();
    selection.setReceivers([
      receiver("video/h265", "video/h264"),
    ]);
    const unsubscribe = selection.onCodecsChanged(first);
    selection.onCodecsChanged(second);
    expect(selection.selected()).toEqual({
      video: "video/h265",
      audio: "audio/opus",
    });
    selection.setReceivers([
      receiver("video/h265", "video/h264"),
      receiver("video/h264"),
    ]);
    expect(selection.selected()?.video).toBe("video/h264");
    selection.setReceivers([receiver("video/h264")]);
    expect(first).toHaveBeenCalledTimes(1);
    unsubscribe();
    selection.setReceivers([
      receiver("video/h265", "video/h264"),
    ]);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    selection.setReceivers([receiver("video/vp8")]);
    expect(selection.selected()?.video).toBe("video/vp8");
    selection.setReceivers([receiver()]);
    expect(() => selection.selected()).toThrow("No common");
  });
  it("preserves manual choices and does not reconnect video-only capture for audio changes", async () => {
    const selection = await createNativeCodecSelection(
      share(),
      { codec: "video/h264", audioCodec: "audio/opus" },
    );
    selection.setReceivers([receiver("video/h265")]);
    const changed = vi.fn();
    selection.onCodecsChanged(changed);
    selection.setReceivers([{ video: [], audio: [] }]);
    expect(selection.selected()).toEqual({
      video: "video/h264",
      audio: "audio/opus",
    });
    expect(changed).not.toHaveBeenCalled();
  });
  it("respects an explicitly selected encoder and capture colour constraints", async () => {
    const selection = await createNativeCodecSelection(
      share(),
      { encoder: "software", colorMatrix: "bt709" },
    );
    selection.setReceivers([
      receiver("video/h264", "video/vp8", "video/av1"),
    ]);
    expect(selection.selected()?.video).toBe("video/av1");
    selection.setReceivers([receiver("video/vp8")]);
    expect(() => selection.selected()).toThrow("No common");
  });
});
