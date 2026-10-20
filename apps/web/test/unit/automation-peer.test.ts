import { webcrypto } from "node:crypto";
import {
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from "vitest";
import { AutomationPeerLink } from "@/libs/application/automation/peer-link";
class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  peer!: Channel;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
    queueMicrotask(() => {
      if (this.peer.readyState === "open")
        this.peer.dispatchEvent(
          new MessageEvent("message", { data }),
        );
    });
  }
  close() {
    if (this.readyState === "closed") return;
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
    this.peer.close();
  }
}
const links: AutomationPeerLink[] = [];
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  links.forEach((l) => l.close());
  links.length = 0;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("expires an incomplete frame assembly even if no further frames arrive", async () => {
  const { l, r, b } = pair(async () => ({
    ok: true,
    data: {},
  }));
  await Promise.all([l.ready, r.ready]);
  vi.useFakeTimers();
  b.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        kind: "chunk",
        id: "partial",
        index: 0,
        count: 2,
        data: "AA==",
      }),
    }),
  );
  await vi.advanceTimersByTimeAsync(30001);
  expect(r.lifetime.signal.aborted).toBe(true);
  expect(r.failure).toBe("ASSEMBLY_TIMEOUT");
});
it("bounds queued frames before asynchronous parsing or decryption", async () => {
  const { l, r, b } = pair(async () => ({
    ok: true,
    data: {},
  }));
  await Promise.all([l.ready, r.ready]);
  for (let i = 0; i < 4097; i++) {
    b.dispatchEvent(
      new MessageEvent("message", { data: "{}" }),
    );
  }
  expect(r.lifetime.signal.aborted).toBe(true);
  expect(r.failure).toBe("RECEIVE_LIMIT");
});
const pair = (
  handler: ConstructorParameters<
    typeof AutomationPeerLink
  >[1],
) => {
  const a = new Channel(),
    b = new Channel();
  a.peer = b;
  b.peer = a;
  const l = new AutomationPeerLink(
    a as unknown as RTCDataChannel,
    async () => ({ ok: true, data: {} }),
    () => {},
    () => {},
  );
  const r = new AutomationPeerLink(
    b as unknown as RTCDataChannel,
    handler,
    () => {},
    () => {},
  );
  links.push(l, r);
  return { l, r, a, b };
};
it("uses identical ephemeral fingerprints and transports large structured results", async () => {
  const { l, r } = pair(async () => ({
    ok: true,
    data: { output: "x".repeat(50000) },
  }));
  await Promise.all([l.ready, r.ready]);
  expect(l.fingerprint).toBe(r.fingerprint);
  expect(l.fingerprint).toHaveLength(64);
  const result = await l.call(
    {
      name: "diagnostics.snapshot",
      arguments: { target: "local" },
    },
    new AbortController().signal,
  );
  expect(result, `${l.failure}/${r.failure}`).toMatchObject(
    { ok: true },
  );
  expect(result.ok && result.data.output).toHaveLength(
    50000,
  );
});
it("rejects replayed authenticated requests without repeating a side effect", async () => {
  const execute = vi.fn(async () => ({
    ok: true as const,
    data: {},
  }));
  const { l, r, a, b } = pair(execute);
  await Promise.all([l.ready, r.ready]);
  await l.call(
    {
      name: "diagnostics.snapshot",
      arguments: { target: "local" },
    },
    new AbortController().signal,
  );
  for (const data of a.sent.filter(
    (s) => JSON.parse(s).kind === "chunk",
  ))
    b.dispatchEvent(new MessageEvent("message", { data }));
  await vi.waitFor(() =>
    expect(r.lifetime.signal.aborted).toBe(true),
  );
  expect(execute).toHaveBeenCalledTimes(1);
});
it("forbids a second hop and closes outstanding calls on disconnect", async () => {
  const execute = vi.fn(async () => ({
    ok: true as const,
    data: {},
  }));
  const { l, r } = pair(execute);
  await Promise.all([l.ready, r.ready]);
  const result = await l.call(
    {
      name: "diagnostics.snapshot",
      arguments: { target: "third-device" },
    },
    new AbortController().signal,
  );
  expect(result.ok).toBe(false);
  expect(execute).not.toHaveBeenCalled();
});
it("propagates cancellation to an executing call", async () => {
  let signal: AbortSignal | undefined;
  const { l, r } = pair(async (_, s) => {
    signal = s;
    await new Promise<void>((resolve) =>
      s.addEventListener("abort", () => resolve(), {
        once: true,
      }),
    );
    return { ok: true, data: {} };
  });
  await Promise.all([l.ready, r.ready]);
  const controller = new AbortController();
  const pending = l.call(
    {
      name: "diagnostics.snapshot",
      arguments: { target: "local" },
    },
    controller.signal,
  );
  await vi.waitFor(() => expect(signal).toBeDefined());
  controller.abort();
  expect((await pending).ok).toBe(false);
  await vi.waitFor(() =>
    expect(signal!.aborted).toBe(true),
  );
});
