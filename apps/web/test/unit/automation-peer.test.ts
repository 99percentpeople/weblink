import { webcrypto } from "node:crypto";
import {
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from "vitest";
import { AutomationPeerLink } from "@/libs/application/automation/peer-link";
import type { ToolCall } from "@weblink/automation";
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
it("bounds queued frames before asynchronous parsing", async () => {
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
  state = "open",
) => {
  const a = new Channel(),
    b = new Channel();
  a.readyState = b.readyState = state;
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
it("opens without an extra handshake and transports large structured results", async () => {
  const { l, r, a, b } = pair(async () => ({
    ok: true,
    data: { output: "x".repeat(50000) },
  }));
  await Promise.all([l.ready, r.ready]);
  expect(a.sent).toEqual([]);
  expect(b.sent).toEqual([]);
  expect(l.connected && r.connected).toBe(true);
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
it("transports a maximum-budget screenshot and preserves crop coordinates", async () => {
  // A 4 MiB PNG grows once in its result field and again in transport framing.
  const image = btoa("x".repeat(4 * 1024 * 1024));
  const expected = {
    mimeType: "image/png",
    data: image,
    imageWidth: 2048,
    imageHeight: 1152,
    coordinateSpace: "desktopPhysicalPixels",
    sourceId: "window",
    geometryRevision: "layout",
    bounds: {
      left: -2000,
      top: -100,
      width: 2560,
      height: 1440,
    },
    imageToDesktop: {
      scaleX: 1.25,
      scaleY: 1.25,
      offsetX: -2000,
      offsetY: -100,
    },
  };
  const execute = vi.fn(async (_call: ToolCall) => ({
    ok: true as const,
    data: expected,
  }));
  const { l, r } = pair(execute);
  await Promise.all([l.ready, r.ready]);
  const call = {
    name: "control.screenshot",
    arguments: {
      target: "local",
      sourceId: "window",
      maxWidth: 2048,
      maxHeight: 2048,
      rect: expected.bounds,
    },
  };
  const result = await l.call(
    call,
    new AbortController().signal,
  );
  expect(result, `${l.failure}/${r.failure}`).toEqual({
    ok: true,
    data: expected,
  });
  expect(execute.mock.calls[0]?.[0]).toEqual(call);
  expect(l.connected && r.connected).toBe(true);
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
  expect(await pending).toMatchObject({
    ok: false,
    error: { code: "CANCELLED" },
  });
  await vi.waitFor(() =>
    expect(signal!.aborted).toBe(true),
  );
});

it("waits only for DataChannel open and sends no identity exchange", async () => {
  const { l, r, a, b } = pair(
    async () => ({ ok: true, data: {} }),
    "connecting",
  );
  let ready = false;
  void l.ready.then(() => {
    ready = true;
  });
  await Promise.resolve();
  expect(ready).toBe(false);
  for (const channel of [a, b]) {
    channel.readyState = "open";
    channel.dispatchEvent(new Event("open"));
  }
  await Promise.all([l.ready, r.ready]);
  expect(ready).toBe(true);
  expect(a.sent).toEqual([]);
  expect(b.sent).toEqual([]);
});

it("closes a stalled opening channel without leaving an unresolved readiness wait", async () => {
  vi.useFakeTimers();
  const { l, a } = pair(
    async () => ({ ok: true, data: {} }),
    "connecting",
  );
  const pending = expect(l.ready).rejects.toMatchObject({
    code: "TARGET_DISCONNECTED",
  });
  await vi.advanceTimersByTimeAsync(10001);
  await pending;
  expect(l.failure).toBe("OPEN_TIMEOUT");
  expect(a.readyState).toBe("closed");
  expect(a.sent).toEqual([]);
});
