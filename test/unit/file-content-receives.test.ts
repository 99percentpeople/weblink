import { describe, expect, it, vi } from "vitest";
import { FileContentReceives } from "@/libs/application/transfer/file-content-receives";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";
import type { TransferRun } from "@/libs/application/transfer/transfer-registry";
import type { FileFingerprint } from "@/libs/domain/protocol/file-fingerprint";
const fingerprint: FileFingerprint = {
  version: 1,
  algorithm: "blake3-256",
  digest: "a".repeat(64),
  size: 3,
};
const recipient = (id: string) => ({
  id,
  fileId: id,
  complete: vi.fn(async () => {}),
  paused: vi.fn(),
  release: vi.fn(async () => {}),
  stop: vi.fn(),
});
function setup() {
  const controller = new AbortController();
  const events = new MultiEventEmitter<{
    complete: void;
  }>();
  const run = {
    messageId: "source",
    signal: controller.signal,
    transferer: events,
  } as unknown as TransferRun;
  const stop = vi.fn(() => controller.abort());
  return {
    coordinator: new FileContentReceives(stop),
    run,
    events,
    controller,
    stop,
  };
}
describe("concurrent content receives", () => {
  it("uses one source and completes waiters only after verified transfer completion", async () => {
    const f = setup(),
      first = recipient("source"),
      second = recipient("second");
    expect(f.coordinator.join(fingerprint, first)).toBe(
      true,
    );
    expect(f.coordinator.join(fingerprint, second)).toBe(
      false,
    );
    f.coordinator.bind(f.run);
    expect(second.complete).not.toHaveBeenCalled();
    f.events.dispatchEvent("complete", undefined);
    expect(second.complete).toHaveBeenCalledOnce();
    expect(first.complete).not.toHaveBeenCalled();
    f.controller.abort();
    expect(second.paused).not.toHaveBeenCalled();
  });
  it("detaching the source keeps the run alive for another offer; the last cancellation stops it", () => {
    const f = setup(),
      first = recipient("source"),
      second = recipient("second");
    f.coordinator.join(fingerprint, first);
    f.coordinator.join(fingerprint, second);
    f.coordinator.bind(f.run);
    expect(f.coordinator.cancel("source")).toBe(true);
    expect(f.stop).not.toHaveBeenCalled();
    expect(f.coordinator.cancel("second")).toBe(true);
    expect(f.stop).toHaveBeenCalledOnce();
  });
  it("failure releases the reservation, retains resumable messages and never acknowledges availability", () => {
    const f = setup(),
      first = recipient("source"),
      second = recipient("second");
    f.coordinator.join(fingerprint, first);
    f.coordinator.join(fingerprint, second);
    f.coordinator.bind(f.run);
    f.controller.abort(new Error("Disconnected"));
    expect(second.complete).not.toHaveBeenCalled();
    expect(second.paused).toHaveBeenCalledWith(
      expect.any(Error),
    );
    expect(
      f.coordinator.join(fingerprint, recipient("retry")),
    ).toBe(true);
  });
  it("stops detached source preparation when the last waiter cancels before a run exists", () => {
    const f = setup(),
      first = recipient("source"),
      second = recipient("second");
    f.coordinator.join(fingerprint, first);
    f.coordinator.join(fingerprint, second);
    f.coordinator.cancel(first.fileId);
    expect(first.stop).not.toHaveBeenCalled();
    f.coordinator.cancel(second.fileId);
    expect(first.stop).toHaveBeenCalledOnce();
    expect(f.coordinator.ownsSource(first.fileId)).toBe(
      false,
    );
    expect(
      f.coordinator.join(fingerprint, recipient("new")),
    ).toBe(true);
  });
});
