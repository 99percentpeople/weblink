import { afterEach, expect, it, vi } from "vitest";
import type { NativeScreenShare } from "@weblink/platform";
import { createNativeCodecSelection } from "@/libs/application/native-codec-selection";
import { NativeScreenPeers } from "@/libs/application/native-screen-peers";
import {
  NativeScreenSender,
  type NativeScreenPublication,
} from "@/libs/domain/native-screen/sender";
import type { ScreenSignal } from "@/libs/domain/native-screen/signaling";

const flush = async () => {
  for (let i = 0; i < 40; i++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

it.each([false, true])(
  "joins a second receiver across automatic codec changes with delayed encoder release (HEVC=%s)",
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
    selection.setReceivers([modern]);
    let release!: () => void;
    const retired = new Promise<void>((r) => (release = r));
    const active = new Map<string, string>();
    const created: string[] = [];
    let firstId: string | undefined;
    const peers = new NativeScreenPeers(async (id) => {
      if (id === firstId) await retired;
      active.delete(id);
    });
    const publication: NativeScreenPublication = {
      sourceId: "shared-screen",
      setReceivers: selection.setReceivers,
      onCodecsChanged: selection.onCodecsChanged,
      offer: (id) =>
        peers.offer(id, async () => {
          // Model a native host with capacity for the two intended receivers.
          if (active.size >= 2)
            throw new Error("Encoder session limit");
          const codec = selection.selected()!.video;
          active.set(id, codec);
          created.push(codec);
          return "offer";
        }),
      answer: async () => {},
      closePeer: (id) => peers.close(id),
    };
    const errors = vi.fn();
    const sender = () => {
      const signals: ScreenSignal[] = [];
      return {
        signals,
        sender: new NativeScreenSender(publication, {
          ready: () => true,
          selected: () => true,
          trickleIce: () => false,
          controlContext: async () => undefined,
          loadIceServers: async () => [],
          relayOnly: () => false,
          send: (signal) => signals.push(signal),
          error: errors,
        }),
      };
    };
    const first = sender();
    let second: ReturnType<typeof sender> | undefined;
    try {
      await first.sender.publish();
      firstId = [...active.keys()][0];
      await first.sender.handle({
        type: "answer",
        id: firstId!,
        sdp: "answer",
      });
      // Main-channel readiness precedes the new receiver's media hello.
      selection.setReceivers([modern, undefined]);
      second = sender();
      const joining = second.sender.publish();
      await flush();
      selection.setReceivers([
        modern,
        hevc
          ? modern
          : { ...modern, video: ["video/h264"] },
      ]);
      await flush();
      expect(created).toEqual(["video/h265"]);
      release();
      await joining;
      await flush();
      const expected = hevc ? "video/h265" : "video/h264";
      expect(created).toEqual([
        "video/h265",
        expected,
        expected,
      ]);
      expect([...active.values()]).toEqual([
        expected,
        expected,
      ]);
      expect(errors).not.toHaveBeenCalled();
      expect(
        first.signals.filter((s) => s.type === "offer"),
      ).toHaveLength(2);
      expect(
        second.signals.filter((s) => s.type === "offer"),
      ).toHaveLength(1);
      // Late feedback from the retired codec must not tear down either new peer.
      await first.sender.handle({
        type: "receiver-status",
        id: firstId!,
        state: "unsupported",
      });
      expect(active.size).toBe(2);
    } finally {
      release();
      first.sender.dispose();
      second?.sender.dispose();
      await flush();
    }
    expect(active.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  },
);
