// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  TransferRegistry,
  type TransferRun,
} from "@/libs/application/transfer/transfer-registry";
import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import type { PeerSession } from "@/libs/domain/session";
import type { FileTransferStates } from "@/libs/application/transfer/file-transfer-state";
import {
  FakeTransfer,
  fakeCache,
} from "../support/file-transfer";
import {
  deferred,
  flushRtc,
} from "../support/rtc-transport";

class Channel extends EventTarget {
  protocol = "transfer";
  readyState = "open";
  onmessage: ((event: MessageEvent) => void) | null = null;
  peer!: Channel;
  reorderStart = false;
  private heldSlot?: string;
  send(data: string) {
    if (
      this.reorderStart &&
      JSON.parse(data).type === "transfer-slot"
    ) {
      this.heldSlot = data;
      return;
    }
    queueMicrotask(() => {
      if (this.peer.readyState !== "open") return;
      const event = new MessageEvent("message", { data });
      this.peer.dispatchEvent(event);
      this.peer.onmessage?.(event);
    });
    if (
      this.heldSlot &&
      JSON.parse(data).type === "transfer-start"
    ) {
      const slot = this.heldSlot;
      this.heldSlot = undefined;
      this.reorderStart = false;
      this.send(slot);
    }
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
    this.peer.close();
  }
}

const endpoints: TransferRegistry[] = [];
function endpoint(id: string, limit = 3) {
  const state: FileTransferStates = {};
  const failed = vi.fn();
  const complete = vi.fn(async (_run: TransferRun) => {});
  const registry = new TransferRegistry({
    maxConcurrentTransfers: limit,
    channelTimeoutMs: 1000,
    createTransfer: ({ cache, mode }) =>
      new FakeTransfer(cache, mode),
    publish: (id, run) => {
      if (run) state[id] = run;
      else delete state[id];
    },
    bind: () => {},
    failed,
    complete,
    automaticCacheDeletion: () => false,
    reportError: failed,
  });
  const node = { id, registry, state, complete, failed };
  endpoints.push(registry);
  return node;
}

async function connect(
  sender: ReturnType<typeof endpoint>,
  receiver: ReturnType<typeof endpoint>,
  id: string,
  prepare?: (
    transfers: FakeTransfer[],
    channels: Channel[],
  ) => void,
) {
  const pair = [new Channel(), new Channel()];
  pair[0].peer = pair[1];
  pair[1].peer = pair[0];
  const runs = [sender, receiver].map((node, index) =>
    node.registry.register({
      session: {
        clientId: node.id,
        targetClientId: index ? sender.id : receiver.id,
      } as PeerSession,
      mode: index
        ? TransferMode.Receive
        : TransferMode.Send,
      cache: fakeCache(id),
      incomingChannel: !!index,
      queue: true,
    }),
  );
  const transfers = runs.map(
    (run) => run.transferer as FakeTransfer,
  );
  pair.forEach((channel, index) =>
    channel.addEventListener("close", () =>
      transfers[index].close(),
    ),
  );
  prepare?.(transfers, pair);
  await Promise.all(
    [sender, receiver].map((node, index) =>
      node.registry.initialize(runs[index]),
    ),
  );
  // The incoming endpoint can observe open before createChannel resolves at the creator.
  receiver.registry.setChannel(
    runs[1],
    pair[1] as unknown as RTCDataChannel,
  );
  await flushRtc();
  sender.registry.setChannel(
    runs[0],
    pair[0] as unknown as RTCDataChannel,
  );
  await flushRtc();
  return { runs, pair, transfers };
}

beforeEach(() => vi.useFakeTimers());
afterEach(async () => {
  endpoints
    .splice(0)
    .forEach((registry) => registry.clear());
  await flushRtc();
  vi.useRealTimers();
});

describe("queued file runs", () => {
  it("waits for both slots even when unordered channels deliver start before slot", async () => {
    const a = endpoint("a", 1),
      b = endpoint("b", 1);
    const pair = await connect(
      a,
      b,
      "unordered",
      (transfers, channels) => {
        channels[1].reorderStart = true;
        transfers[0].addEventListener("ready", () => {
          expect(transfers[1].channel).toBe(channels[1]);
        });
      },
    );
    pair.transfers.forEach((transfer) => {
      expect(transfer.initialize).toHaveBeenCalledOnce();
      expect(transfer.setChannel).toHaveBeenCalledOnce();
    });
    expect(a.failed).not.toHaveBeenCalled();
    expect(b.failed).not.toHaveBeenCalled();
  });

  it("drains a three-peer cycle without holding slots in opposite orders", async () => {
    const a = endpoint("a", 1),
      b = endpoint("b", 1),
      c = endpoint("c", 1);
    const pending = [
      await connect(a, b, "ab"),
      await connect(b, c, "bc"),
      await connect(c, a, "ca"),
    ];
    while (pending.length) {
      const index = pending.findIndex(({ transfers }) =>
        transfers.every((transfer) => transfer.channel),
      );
      expect(index).toBeGreaterThanOrEqual(0);
      pending.splice(index, 1)[0].transfers[1].finish();
      await flushRtc();
    }
    [a, b, c].forEach((node) =>
      expect(node.failed).not.toHaveBeenCalled(),
    );
  });

  it("admits three at a time, keeps queued runs beyond channel deadlines and holds slots through finalization", async () => {
    const a = endpoint("a");
    const b = endpoint("b");
    const runs = [];
    for (let i = 0; i < 6; i++)
      runs.push(await connect(a, b, `file-${i}`));
    expect(
      runs.map(
        ({ transfers }) =>
          transfers[0].setChannel.mock.calls.length,
      ),
    ).toEqual([1, 1, 1, 0, 0, 0]);
    expect(
      runs[3].transfers[1].initialize,
    ).not.toHaveBeenCalled();
    expect(
      Object.values(a.state).filter((run) => run?.queued),
    ).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(a.failed).not.toHaveBeenCalled();
    expect(b.failed).not.toHaveBeenCalled();
    const merging = deferred<void>();
    b.complete.mockReturnValueOnce(merging.promise);
    runs[0].transfers[1].finish();
    await flushRtc();
    expect(
      runs[3].transfers[1].initialize,
    ).not.toHaveBeenCalled();
    merging.resolve();
    await flushRtc();
    expect(
      runs[3].transfers[0].setChannel,
    ).toHaveBeenCalledOnce();
    expect(
      runs[3].transfers[1].setChannel,
    ).toHaveBeenCalledOnce();
    expect(
      runs[4].transfers[0].initialize,
    ).not.toHaveBeenCalled();
  });

  it("makes progress with opposite-direction requests and unequal endpoint limits", async () => {
    const a = endpoint("a", 2);
    const b = endpoint("b", 1);
    const outgoing = await connect(a, b, "outgoing");
    const incoming = await connect(b, a, "incoming");
    expect(
      outgoing.transfers[0].setChannel,
    ).toHaveBeenCalledOnce();
    expect(
      incoming.transfers[0].setChannel,
    ).not.toHaveBeenCalled();
    outgoing.transfers[1].finish();
    await flushRtc();
    expect(
      incoming.transfers[0].setChannel,
    ).toHaveBeenCalledOnce();
    expect(
      incoming.transfers[1].setChannel,
    ).toHaveBeenCalledOnce();
  });

  it("cancels waiting work, releases closed sessions and admits the next queued transfer", async () => {
    const a = endpoint("a", 1);
    const b = endpoint("b", 1);
    const first = await connect(a, b, "first");
    const cancelled = await connect(a, b, "cancelled");
    const next = await connect(a, b, "next");
    a.registry.destroy(cancelled.runs[0]);
    a.registry.closeSession(first.runs[0].session);
    await flushRtc();
    expect(
      cancelled.runs.every((run) => run.signal.aborted),
    ).toBe(true);
    expect(
      cancelled.transfers[0].initialize,
    ).not.toHaveBeenCalled();
    expect(
      next.transfers[0].setChannel,
    ).toHaveBeenCalledOnce();
    expect(
      next.transfers[1].setChannel,
    ).toHaveBeenCalledOnce();
    expect(a.failed).not.toHaveBeenCalled();
  });

  it("still times out missing channels and failed initialization, releasing the queue", async () => {
    const a = endpoint("a", 1);
    const b = endpoint("b", 1);
    const missing = a.registry.register({
      session: {
        clientId: "a",
        targetClientId: "b",
      } as PeerSession,
      mode: TransferMode.Send,
      cache: fakeCache("missing"),
      incomingChannel: true,
      queue: true,
    });
    await a.registry.initialize(missing);
    await vi.advanceTimersByTimeAsync(1000);
    expect(missing.signal.aborted).toBe(true);
    expect(a.failed).toHaveBeenCalledOnce();
    const broken = await connect(
      a,
      b,
      "broken",
      (transfers) => {
        transfers[0].initialize.mockReturnValue(
          new Promise(() => {}),
        );
      },
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(
      broken.runs.every((run) => run.signal.aborted),
    ).toBe(true);
    expect(a.failed).toHaveBeenCalledTimes(2);
    const next = await connect(a, b, "next");
    expect(
      next.transfers[0].setChannel,
    ).toHaveBeenCalledOnce();
  });
});
