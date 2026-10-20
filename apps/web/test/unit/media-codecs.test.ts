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
  it("selects formats independently for modern, legacy and unsupported receivers", () => {
    const local = ["video/h265", "video/h264", "video/vp8"];
    expect(
      commonCodecs("video", local, [
        receiver("video/h265", "video/h264"),
      ]),
    ).toEqual(["video/h265", "video/h264"]);
    expect(
      commonCodecs("video", local, [undefined]),
    ).toEqual(["video/h264", "video/vp8"]);
    expect(
      commonCodecs("video", local, [receiver("video/vp8")]),
    ).toEqual(["video/vp8"]);
    expect(
      commonCodecs("video", local, [receiver()]),
    ).toEqual([]);
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
  it("uses the streaming priority for recording without depending on viewer order", async () => {
    const selection =
      await createNativeCodecSelection(share());
    expect(selection.recording()?.video).toBe("video/h265");
    selection.select(receiver("video/h264"));
    selection.select(receiver("video/vp8"));
    expect(selection.recording()?.video).toBe("video/h265");
    const manual = await createNativeCodecSelection(
      share(),
      { codec: "video/h264" },
    );
    expect(manual.recording()?.video).toBe("video/h264");
    const unsupported = await createNativeCodecSelection(
      share(),
      { codec: "video/vp8" },
    );
    expect(unsupported.recording()).toBeUndefined();
    const software = await createNativeCodecSelection(
      share(),
      { encoder: "software" },
    );
    expect(software.recording()).toBeUndefined();
  });
  it("selects independently without changing a previous receiver's format", async () => {
    const selection = await createNativeCodecSelection(
      share(),
      { audio: true },
    );
    const modern = receiver("video/h265", "video/h264");
    const first = selection.select(modern);
    expect(first).toEqual({
      video: "video/h265",
      audio: "audio/opus",
    });
    expect(
      selection.select(receiver("video/h264")).video,
    ).toBe("video/h264");
    expect(
      selection.select(receiver("video/vp8")).video,
    ).toBe("video/vp8");
    expect(() => selection.select(receiver())).toThrow(
      "No common",
    );
    expect(first).toEqual(selection.select(modern));
    expect(selection.select().video).toBe("video/h264");
    expect(selection.select(modern)).toEqual(first);
  });
  it("preserves manual choices and does not reconnect video-only capture for audio changes", async () => {
    const selection = await createNativeCodecSelection(
      share(),
      { codec: "video/h264", audioCodec: "audio/opus" },
    );
    const chosen = selection.select(receiver("video/h265"));
    expect(chosen).toEqual({
      video: "video/h264",
      audio: "audio/opus",
    });
    expect(
      selection.select({ video: [], audio: [] }),
    ).toEqual(chosen);
  });
  it("respects an explicitly selected encoder and capture colour constraints", async () => {
    const selection = await createNativeCodecSelection(
      share(),
      { encoder: "software", colorMatrix: "bt709" },
    );
    expect(
      selection.select(
        receiver("video/h264", "video/vp8", "video/av1"),
      ).video,
    ).toBe("video/av1");
    expect(() =>
      selection.select(receiver("video/vp8")),
    ).toThrow("No common");
  });
});
