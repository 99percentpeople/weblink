import { describe, expect, it } from "vitest";
import { TransferQueue } from "@/libs/application/transfer/transfer-queue";

describe("transfer queue admission", () => {
  it("defaults to three slots, keeps FIFO order and removes cancelled waiters", async () => {
    const queue = new TransferQueue();
    const controllers = Array.from(
      { length: 6 },
      () => new AbortController(),
    );
    const started: number[] = [];
    const jobs = controllers.map((controller, index) =>
      queue
        .acquire(controller.signal)
        .then(() => started.push(index)),
    );
    const cancelled = expect(jobs[3]).rejects.toMatchObject(
      { name: "AbortError" },
    );
    await Promise.all(jobs.slice(0, 3));
    expect(started).toEqual([0, 1, 2]);
    controllers[3].abort();
    await cancelled;
    controllers[1].abort();
    await jobs[4];
    expect(started).toEqual([0, 1, 2, 4]);
    controllers[0].abort();
    await jobs[5];
    expect(started).toEqual([0, 1, 2, 4, 5]);
    controllers.forEach((controller) => controller.abort());
  });

  it("applies increases immediately and drains existing runs before a lower limit", async () => {
    const queue = new TransferQueue(1);
    const controllers = Array.from(
      { length: 5 },
      () => new AbortController(),
    );
    const started: number[] = [];
    const jobs = controllers.map((controller, index) =>
      queue
        .acquire(controller.signal)
        .then(() => started.push(index)),
    );
    await jobs[0];
    queue.setLimit(3);
    await Promise.all(jobs.slice(0, 3));
    queue.setLimit(1);
    controllers[0].abort();
    controllers[1].abort();
    await Promise.resolve();
    expect(started).toEqual([0, 1, 2]);
    controllers[2].abort();
    await jobs[3];
    expect(started).toEqual([0, 1, 2, 3]);
    controllers[3].abort();
    await jobs[4];
    controllers[4].abort();
  });

  it("counts legacy runs and rejects already cancelled requests without consuming capacity", async () => {
    const queue = new TransferQueue(1);
    const legacy = new AbortController();
    queue.occupy(legacy.signal);
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      queue.acquire(cancelled.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    const next = new AbortController();
    let started = false;
    const pending = queue.acquire(next.signal).then(() => {
      started = true;
    });
    await Promise.resolve();
    expect(started).toBe(false);
    legacy.abort();
    await pending;
    next.abort();
  });
});
