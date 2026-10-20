import { afterEach, expect, it, vi } from "vitest";
import type { NativeScreenShare } from "@weblink/platform";
import { createNativeCodecSelection } from "@/libs/application/native-codec-selection";
import { NativeScreenPeers } from "@/libs/application/native-screen-peers";
import {
  NativeScreenSender,
  type NativeScreenPublication,
} from "@/libs/domain/native-screen/sender";
import type { ScreenSignal } from "@/libs/domain/native-screen/signaling";
import type { MediaDecodeCapabilities } from "@/libs/domain/protocol/media-codecs";

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

it.each([false, true])(
  "keeps the first native connection during another receiver's join, codec change and leave (HEVC=%s)",
  async (hevc) => {
    vi.useFakeTimers();
    const selection = await createNativeCodecSelection({
      encoders: async () => [
        {
          id: "hardware",
          hardware: true,
          codecs: ["video/h265", "video/h264"],
        },
      ],
      codecs: async () => ["audio/opus"],
    } as unknown as NativeScreenShare);
    const modern = {
      video: ["video/h265", "video/h264"],
      audio: ["audio/opus"],
    };
    const legacy = { ...modern, video: ["video/h264"] };
    let release!: () => void;
    const retired = new Promise<void>((r) => (release = r));
    const active = new Map<string, string>();
    const created: string[] = [];
    let retiringId: string | undefined;
    const closeNative = vi.fn(async (id: string) => {
      if (id === retiringId) await retired;
      active.delete(id);
    });
    const peers = new NativeScreenPeers(closeNative);
    const publication: NativeScreenPublication = {
      sourceId: "shared-screen",
      selectCodecs: selection.select,
      offer: (
        id,
        _servers,
        _relay,
        _candidate,
        _control,
        codecs,
      ) =>
        peers.offer(id, async () => {
          // Each receiver has its own native encoder; keep the two-session limit.
          if (active.size >= 2)
            throw new Error("Encoder session limit");
          active.set(id, codecs!.video);
          created.push(codecs!.video);
          return "offer";
        }),
      answer: async () => {},
      closePeer: (id) => peers.close(id),
    };
    const sender = (
      decode: MediaDecodeCapabilities | undefined,
      ready: boolean,
    ) => {
      const signals: ScreenSignal[] = [];
      const state = { decode, ready };
      const errors = vi.fn();
      return {
        signals,
        state,
        errors,
        sender: new NativeScreenSender(publication, {
          ready: () => state.ready,
          selected: () => true,
          trickleIce: () => false,
          decodeCapabilities: () => state.decode,
          controlContext: async () => undefined,
          loadIceServers: async () => [],
          relayOnly: () => false,
          send: (signal) => signals.push(signal),
          error: errors,
        }),
      };
    };
    const first = sender(modern, true),
      second = sender(undefined, false),
      unsupported = sender({ ...modern, video: [] }, true);
    try {
      await first.sender.publish();
      const firstId = [...active.keys()][0];
      await first.sender.handle({
        type: "answer",
        id: firstId,
        sdp: "answer",
      });
      await second.sender.publish();
      expect(created).toEqual(["video/h265"]);
      second.state.decode = hevc ? modern : legacy;
      second.state.ready = true;
      await second.sender.publish();
      expect(created).toEqual([
        "video/h265",
        hevc ? "video/h265" : "video/h264",
      ]);
      expect(closeNative).not.toHaveBeenCalled();
      retiringId = [...active.keys()].find(
        (id) => id !== firstId,
      );
      // A real capability change retires only the changed receiver, even if
      // releasing its hardware encoder is delayed.
      second.state.decode = hevc ? legacy : modern;
      second.sender.refreshCodecs();
      await flush();
      expect(created).toHaveLength(2);
      expect(active.get(firstId)).toBe("video/h265");
      release();
      await flush();
      expect(created).toEqual([
        "video/h265",
        hevc ? "video/h265" : "video/h264",
        hevc ? "video/h264" : "video/h265",
      ]);
      expect(active.size).toBe(2);
      await second.sender.handle({
        type: "receiver-status",
        id: retiringId!,
        state: "unsupported",
      });
      expect(active.size).toBe(2);
      second.sender.dispose();
      await flush();
      expect([...active]).toEqual([
        [firstId, "video/h265"],
      ]);
      // An incompatible join fails locally. A corrected report can recover
      // during retry backoff without replacing the already healthy viewer.
      await unsupported.sender.publish();
      expect(unsupported.errors).toHaveBeenCalledOnce();
      expect([...active]).toEqual([
        [firstId, "video/h265"],
      ]);
      unsupported.state.decode = legacy;
      unsupported.sender.refreshCodecs();
      await flush();
      expect([...active.values()]).toEqual([
        "video/h265",
        "video/h264",
      ]);
      unsupported.sender.dispose();
      await flush();
      expect([...active]).toEqual([
        [firstId, "video/h265"],
      ]);
      expect(
        first.signals.filter((s) => s.type === "offer"),
      ).toHaveLength(1);
      expect(
        first.signals.some((s) => s.type === "stop"),
      ).toBe(false);
      expect(first.errors).not.toHaveBeenCalled();
      expect(second.errors).not.toHaveBeenCalled();
      expect(closeNative).not.toHaveBeenCalledWith(firstId);
    } finally {
      release();
      first.sender.dispose();
      second.sender.dispose();
      unsupported.sender.dispose();
      await flush();
    }
    expect(active.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);
