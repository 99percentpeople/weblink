// @vitest-environment node
import { expect, it, vi } from "vitest";
import {
  ALL_FORMATS,
  BufferSource,
  BufferTarget,
  EncodedAudioPacketSource,
  EncodedPacket,
  EncodedPacketSink,
  EncodedVideoPacketSource,
  Input,
  MkvOutputFormat,
  Mp4OutputFormat,
  Output,
  WebMOutputFormat,
} from "mediabunny";
import { remuxRecording } from "@/libs/application/recording-remux";
import type { RecordingEngine } from "@/libs/application/recording-engine";
import { encodedRecordingFormat } from "@/libs/application/recording-encoded-format";
import {
  recordingNalUnits,
  recordingVideoConfig,
} from "@/libs/application/recording-video-config";
import {
  h264Keyframe,
  hevcKeyframe,
} from "../fixtures/recording-packets";

class Recorder
  extends EventTarget
  implements RecordingEngine
{
  state: RecordingState = "inactive";
  mimeType = "";
  last?: Blob;
  start() {
    this.state = "recording";
  }
  pause() {
    this.state = "paused";
  }
  resume() {
    this.state = "recording";
  }
  data(data: Blob) {
    this.dispatchEvent(
      Object.assign(new Event("dataavailable"), { data }),
    );
  }
  stop = vi.fn(() => {
    this.state = "inactive";
    queueMicrotask(() => {
      if (this.last) this.data(this.last);
      this.dispatchEvent(new Event("stop"));
    });
  });
}

async function fixture(
  kind: "webm" | "mkv" | "mp4",
  withAudio = false,
) {
  const data =
    kind === "webm"
      ? new Uint8Array([
          0x10, 0, 0, 0x9d, 1, 0x2a, 64, 0, 48, 0, 0, 1,
        ])
      : Uint8Array.from(
          atob(
            kind === "mkv" ? h264Keyframe : hevcKeyframe,
          ),
          (c) => c.charCodeAt(0),
        );
  const first = {
    data: data.buffer,
    mimeType:
      kind === "webm"
        ? "video/vp8"
        : kind === "mkv"
          ? "video/h264"
          : "video/h265",
    type: "key" as const,
    timestamp: 0,
    width: 64,
    height: 48,
    ssrc: 0,
    spatialIndex: 0,
    segment: 1,
  };
  const format = await encodedRecordingFormat(first);
  if (kind === "mkv") {
    format.config = await recordingVideoConfig(
      "avc",
      format.config,
      first.data,
    );
    format.bytes = (packet) =>
      recordingNalUnits(packet.data);
  }
  const target = new BufferTarget();
  const output = new Output({
    format:
      kind === "webm"
        ? new WebMOutputFormat({ appendOnly: true })
        : kind === "mkv"
          ? new MkvOutputFormat({ appendOnly: true })
          : new Mp4OutputFormat({
              fastStart: "fragmented",
              minimumFragmentDuration: 1,
            }),
    target,
  });
  const video = new EncodedVideoPacketSource(format.codec);
  output.addVideoTrack(video, { frameRate: 1 });
  const audio = withAudio
    ? new EncodedAudioPacketSource("opus")
    : undefined;
  if (audio) output.addAudioTrack(audio);
  await output.start();
  if (audio) {
    for (let i = 0; i < 3; ++i) {
      await audio.add(
        new EncodedPacket(
          new Uint8Array([0xf8, 0xff, 0xfe]),
          "key",
          i * 0.02,
          0.02,
        ),
        {
          decoderConfig: {
            codec: "opus",
            numberOfChannels: 1,
            sampleRate: 48000,
          },
        },
      );
    }
    audio.close();
  }
  for (const timestamp of [0, 1, 2])
    await video.add(
      new EncodedPacket(
        format.bytes(first),
        "key",
        timestamp,
        1,
      ),
      { decoderConfig: format.config },
    );
  await output.finalize();
  return {
    data: new Uint8Array(target.buffer!),
    codec: format.codec,
    packet:
      kind === "mp4"
        ? recordingNalUnits(first.data)
        : format.bytes(first),
  };
}

it.each([
  ["webm", false],
  ["mkv", false],
  ["mp4", false],
  ["webm", true],
  ["mkv", true],
  ["mp4", true],
] as const)(
  "copies %s input (receiver video only: %s), retaining the final chunk, timestamps and seek index",
  async (kind, receiverVideoOnly) => {
    const source = await fixture(kind);
    for (const container of [
      "auto",
      "mkv",
      "mp4",
    ] as const) {
      const raw = new Recorder();
      const recorder = remuxRecording(
        raw,
        container,
        receiverVideoOnly ? { hasAudio: false } : undefined,
      );
      const chunks: Blob[] = [],
        errors: unknown[] = [];
      recorder.addEventListener("dataavailable", (event) =>
        chunks.push((event as BlobEvent).data),
      );
      recorder.addEventListener("error", (event) =>
        errors.push(
          (event as Event & { error: unknown }).error,
        ),
      );
      const done = new Promise<void>((resolve) =>
        recorder.addEventListener("stop", () => resolve(), {
          once: true,
        }),
      );
      try {
        recorder.start();
        const end = source.data.length - 32;
        // Input and output chunk boundaries are unrelated to media packets.
        for (let at = 0; at < end; at += 57)
          raw.data(
            new Blob([
              source.data.subarray(
                at,
                Math.min(end, at + 57),
              ),
            ]),
          );
        recorder.pause();
        expect(raw.state).toBe("paused");
        recorder.resume();
        raw.last = new Blob([source.data.subarray(end)]);
        recorder.stop();
        recorder.stop();
        await done;
        expect(errors).toEqual([]);
        expect(raw.stop).toHaveBeenCalledOnce();
        const bytes = new Uint8Array(
          await new Blob(chunks).arrayBuffer(),
        );
        for (const patch of recorder.getPatches!())
          bytes.set(patch.data, patch.offset);
        const input = new Input({
          formats: ALL_FORMATS,
          source: new BufferSource(bytes),
        });
        try {
          const track =
            (await input.getPrimaryVideoTrack())!;
          expect(track.codec).toBe(source.codec);
          // SimpleBlock stores frame timestamps; the final frame's duration
          // belongs to Segment Info when no fixed frame rate is declared.
          expect(
            await input.getDurationFromMetadata(),
          ).toBeCloseTo(3, 1);
          const packet = await new EncodedPacketSink(
            track,
          ).getKeyPacket(2.5);
          expect(packet?.timestamp).toBe(2);
          expect(packet?.data).toEqual(source.packet);
          expect((await input.getFormat()).mimeType).toBe(
            (container === "auto"
              ? source.codec === "vp8"
                ? "mkv"
                : "mp4"
              : container) === "mkv"
              ? "video/x-matroska"
              : "video/mp4",
          );
        } finally {
          input.dispose();
        }
      } finally {
        await recorder.dispose!();
      }
    }
  },
);

it("shifts the video timeline once by the receiver skew and observed Opus packet duration", async () => {
  vi.stubGlobal("navigator", { userAgent: "Chrome/156.0" });
  const raw = new Recorder(),
    audioSkew = vi.fn(async () => 0.015);
  const recorder = remuxRecording(raw, "mkv", {
    hasAudio: true,
    audioSkew,
  });
  try {
    const source = await fixture("webm", true);
    const chunks: Blob[] = [];
    recorder.addEventListener("dataavailable", (e) =>
      chunks.push((e as BlobEvent).data),
    );
    const done = new Promise<void>((resolve, reject) => {
      recorder.addEventListener("stop", () => resolve());
      recorder.addEventListener("error", (e) =>
        reject((e as Event & { error: unknown }).error),
      );
    });
    recorder.start();
    raw.last = new Blob([source.data]);
    recorder.stop();
    await done;
    expect(audioSkew).toHaveBeenCalledOnce();
    const bytes = new Uint8Array(
      await new Blob(chunks).arrayBuffer(),
    );
    for (const patch of recorder.getPatches!())
      bytes.set(patch.data, patch.offset);
    const input = new Input({
      formats: ALL_FORMATS,
      source: new BufferSource(bytes),
    });
    try {
      const video = new EncodedPacketSink(
        (await input.getPrimaryVideoTrack())!,
      );
      expect(
        (await video.getFirstPacket())?.timestamp,
      ).toBeCloseTo(0.035, 5);
      expect(
        (await video.getKeyPacket(2.1))?.timestamp,
      ).toBeCloseTo(2.035, 5);
      const audio = new EncodedPacketSink(
        (await input.getPrimaryAudioTrack())!,
      );
      expect(
        (await audio.getFirstPacket())?.timestamp,
      ).toBe(0);
    } finally {
      input.dispose();
    }
  } finally {
    await recorder.dispose!();
    vi.unstubAllGlobals();
  }
});

it("reports a missing selected audio track instead of publishing a silent file", async () => {
  const raw = new Recorder();
  const recorder = remuxRecording(raw, "mkv", {
    hasAudio: true,
    audioSkew: async () => 0,
  });
  try {
    const fixtureData = await fixture("webm");
    const failed = vi.fn();
    recorder.addEventListener("error", failed);
    const stopped = new Promise<void>((resolve) =>
      recorder.addEventListener("stop", () => resolve(), {
        once: true,
      }),
    );
    recorder.start();
    raw.last = new Blob([fixtureData.data]);
    recorder.stop();
    await stopped;
    expect(failed).toHaveBeenCalledOnce();
  } finally {
    await recorder.dispose!();
  }
});

it("cancels a pending header read and releases the recorder without waiting for more data", async () => {
  const raw = new Recorder();
  const recorder = remuxRecording(raw, "mkv");
  const failed = vi.fn();
  recorder.addEventListener("error", failed);
  recorder.start();
  await recorder.dispose!();
  expect(raw.stop).toHaveBeenCalledOnce();
  expect(failed).not.toHaveBeenCalled();
});

it("bounds unread input and reports the overflow before stopping", async () => {
  const raw = new Recorder();
  const recorder = remuxRecording(raw, "mkv");
  const errors: unknown[] = [];
  recorder.addEventListener("error", (event) =>
    errors.push(
      (event as Event & { error: unknown }).error,
    ),
  );
  const stopped = new Promise<void>((resolve) =>
    recorder.addEventListener("stop", () => resolve(), {
      once: true,
    }),
  );
  recorder.start();
  raw.data(new Blob([new Uint8Array(33 * 1024 * 1024)]));
  await stopped;
  expect(errors).toHaveLength(1);
  expect(String(errors[0])).toContain("cannot keep up");
  await recorder.dispose!();
});

it("retains the original recorder error and settles pending demux reads", async () => {
  const raw = new Recorder();
  const recorder = remuxRecording(raw, "mp4");
  const errors: unknown[] = [];
  recorder.addEventListener("error", (event) =>
    errors.push(
      (event as Event & { error: unknown }).error,
    ),
  );
  const stopped = new Promise<void>((resolve) =>
    recorder.addEventListener("stop", () => resolve(), {
      once: true,
    }),
  );
  recorder.start();
  const error = new Error("Capture device disconnected");
  raw.dispatchEvent(
    Object.assign(new Event("error"), { error }),
  );
  await stopped;
  expect(errors).toEqual([error]);
  expect(raw.stop).toHaveBeenCalledOnce();
  await recorder.dispose!();
});
