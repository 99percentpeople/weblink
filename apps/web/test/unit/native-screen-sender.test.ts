import { afterEach, expect, it, vi } from "vitest";
import type { NativeScreenShare } from "@weblink/platform";
import { createNativeCodecSelection } from "@/libs/application/native-codec-selection";
import {
  NativeScreenSender,
  type NativeScreenPublication,
} from "@/libs/domain/native-screen/sender";
import type { ScreenSignal } from "@/libs/domain/native-screen/signaling";

afterEach(() => vi.useRealTimers());

async function setup(manual = false) {
  vi.useFakeTimers();
  const selection = await createNativeCodecSelection(
    {
      encoders: async () => [
        {
          id: "hardware",
          hardware: true,
          codecs: ["video/h265", "video/h264"],
        },
      ],
      codecs: async () => ["audio/opus"],
    } as unknown as NativeScreenShare,
    manual ? { codec: "video/h265" } : undefined,
  );
  const signals: ScreenSignal[] = [];
  const offer = vi.fn<NativeScreenPublication["offer"]>(
    async () => "offer",
  );
  const sender = new NativeScreenSender(
    {
      sourceId: "screen",
      selectCodecs: selection.select,
      offer,
      answer: async () => {},
      closePeer: async () => {},
    },
    {
      ready: () => true,
      selected: () => true,
      trickleIce: () => false,
      decodeCapabilities: () => ({
        video: ["video/h265", "video/h264"],
        audio: ["audio/opus"],
      }),
      controlContext: async () => undefined,
      loadIceServers: async () => [],
      relayOnly: () => false,
      send: (signal) => signals.push(signal),
      error: vi.fn(),
    },
  );
  const id = () =>
    signals.filter((s) => s.type === "offer").at(-1)!.id;
  await sender.publish();
  return { sender, id, offer };
}

it("preserves an explicit video format after rejection, including repeated capability updates", async () => {
  const { sender, id, offer } = await setup(true);
  try {
    await sender.handle({
      type: "receiver-status",
      id: id(),
      state: "unsupported",
    });
    sender.refreshCodecs();
    await vi.advanceTimersByTimeAsync(180000);
    expect(offer).toHaveBeenCalledOnce();
  } finally {
    sender.dispose();
  }
});

it("does not count network interruptions or stalls followed by sustained decoding toward a format change", async () => {
  const { sender, id, offer } = await setup();
  try {
    // Two network retries do not use the decoder fallback path.
    for (let retry = 1; retry <= 2; retry++) {
      await sender.handle({ type: "retry", id: id() });
      await vi.advanceTimersByTimeAsync(1000 * retry);
    }
    await sender.handle({
      type: "retry",
      id: id(),
      reason: "decode",
    });
    await vi.advanceTimersByTimeAsync(3000);
    await sender.handle({
      type: "answer",
      id: id(),
      sdp: "answer",
    });
    await sender.handle({
      type: "receiver-status",
      id: id(),
      state: "healthy",
    });
    await sender.handle({
      type: "retry",
      id: id(),
      reason: "decode",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(offer).toHaveBeenCalledTimes(5);
    for (const call of offer.mock.calls)
      expect(call[5]).toEqual({
        video: "video/h265",
        audio: "audio/opus",
      });
  } finally {
    sender.dispose();
  }
});
