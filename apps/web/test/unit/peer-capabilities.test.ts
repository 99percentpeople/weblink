import { advertiseCapabilities } from "@/libs/domain/protocol/protocol-versions";
import { afterEach, expect, it, vi } from "vitest";
import { PeerCapabilitiesService } from "@/libs/application/peer-capabilities";
import {
  validCapabilityUpdate,
  validCurrentCapability,
  type CapabilityChanges,
  type CapabilityUpdate,
  type PeerCapabilities,
} from "@/libs/domain/protocol/capabilities";
import {
  createSessionMessage,
  type SessionMessage,
} from "@/libs/domain/protocol/messages";
import type {
  PeerSession,
  PeerSessionEventMap,
} from "@/libs/domain/session";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";
import {
  deferred,
  flushRtc,
} from "../support/rtc-transport";

const disposers: (() => void)[] = [];
it("accepts optional automation lease status without changing the protocol version", () => {
  for (const value of [
    {},
    { diagnostics: true },
    { diagnostics: false, controlActive: false },
    { controlActive: true },
    { controlActive: false },
  ]) {
    expect(
      validCurrentCapability("automation", value),
    ).toBe(true);
    expect(
      advertiseCapabilities({ automation: value }),
    ).toEqual({ "automation/1": value });
  }
  expect(
    validCurrentCapability("automation", {
      controlActive: "true",
    }),
  ).toBe(false);
});
afterEach(() => {
  disposers.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup(
  initial: PeerCapabilities = {
    files: { content: true, shared: true },
  },
) {
  const events =
    new MultiEventEmitter<PeerSessionEventMap>();
  let local = initial;
  const service = new PeerCapabilitiesService(() => local);
  const send = vi.fn(
    async (
      _message: SessionMessage,
      _options?: { signal?: AbortSignal },
    ) => {},
  );
  const session = {
    clientId: "viewer",
    targetClientId: "host",
    isMessageChannelReady: true,
    addEventListener: events.addEventListener.bind(events),
    sendMessage: send,
  } as unknown as PeerSession;
  const changed = vi.fn();
  const stop = service.bind(session, changed);
  disposers.push(stop);
  const receiveUpdate = (
    update: CapabilityUpdate,
    target = "viewer",
  ) => {
    events.dispatchEvent(
      "message",
      createSessionMessage(
        { clientId: "host", targetClientId: target },
        "peer-capabilities",
        { update },
      ),
    );
  };
  const receive = (
    revision: number,
    services: PeerCapabilities,
    generation = "generation",
    target = "viewer",
  ) =>
    receiveUpdate(
      {
        kind: "snapshot",
        generation,
        revision,
        services: advertiseCapabilities(services),
      },
      target,
    );
  const patch = (
    revision: number,
    services: CapabilityChanges,
  ) =>
    receiveUpdate({
      kind: "patch",
      generation: "generation",
      revision,
      services: advertiseCapabilities(
        services as PeerCapabilities,
      ),
    });
  return {
    service,
    session,
    send,
    changed,
    receive,
    receiveUpdate,
    patch,
    events,
    stop,
    local: (next: PeerCapabilities) => {
      local = next;
      service.refresh(session);
    },
  };
}
it("exchanges one snapshot, ignores stale revisions and scopes it to the current peer transport", async () => {
  const s = setup({
    control: {
      host: true,
      request: true,
      occupancy: { state: "idle" },
    },
  });
  s.service.refresh(s.session);
  expect(s.service.get(s.session)).toBeUndefined();
  const ready = s.service.whenReady(s.session);
  const busy: PeerCapabilities = {
    control: {
      host: true,
      request: true,
      occupancy: {
        state: "controlled",
        clientId: "controller",
        sourceId: "display",
      },
    },
  };
  s.receive(2, busy, "generation", "wrong-peer");
  expect(s.service.get(s.session)).toBeUndefined();
  s.receive(2, busy);
  await expect(ready).resolves.toEqual(busy);
  s.receive(1, {});
  s.receive(2, {});
  s.receive(3, {}, "other-generation");
  expect(s.service.get(s.session)).toEqual(busy);
  expect(s.changed).toHaveBeenCalledOnce();
  await flushRtc();
  s.service.refresh(s.session);
  expect(s.send).toHaveBeenCalledOnce();
  s.events.dispatchEvent("messagechannelchange", "closed");
  expect(s.service.get(s.session)).toBeUndefined();
  s.events.dispatchEvent("messagechannelchange", "ready");
  s.receive(1, {}, "new-generation");
  expect(s.service.get(s.session)).toEqual({});
  await flushRtc();
  expect(s.send).toHaveBeenCalledTimes(2);
});
it("coalesces pending changes without losing the latest occupancy", async () => {
  const s = setup();
  await flushRtc();
  const queued = deferred<void>();
  s.send.mockImplementationOnce(() => queued.promise);
  s.local({ speedTest: { busy: true } });
  s.local({ speedTest: { busy: false } });
  s.local({
    speedTest: { busy: false },
    files: { content: true, shared: true },
  });
  queued.resolve();
  await flushRtc();
  expect(s.send).toHaveBeenCalledTimes(3);
  expect(s.send.mock.calls.at(-1)![0]).toMatchObject({
    update: {
      kind: "patch",
      revision: 3,
      services: {
        "speedTest/1": { busy: false },
        "files/1": { shared: true },
      },
    },
  });
});
it("publishes only changed service entries, including extension additions and withdrawals", async () => {
  const s = setup();
  await flushRtc();
  expect(s.send.mock.calls[0][0]).toMatchObject({
    update: {
      kind: "snapshot",
      services: {
        "files/1": { content: true, shared: true },
      },
    },
  });
  s.local({
    files: { content: true, shared: true },
    "acme.whiteboard": { mode: "edit" },
  });
  await flushRtc();
  expect(s.send.mock.calls.at(-1)![0]).toMatchObject({
    update: {
      kind: "patch",
      services: { "acme.whiteboard/1": { mode: "edit" } },
    },
  });
  const added = s.send.mock.calls.at(-1)![0];
  if (
    added.type !== "peer-capabilities" ||
    !validCapabilityUpdate(added.update) ||
    added.update.kind !== "patch"
  )
    throw new Error("Missing patch");
  expect(Object.keys(added.update.services)).toEqual([
    "acme.whiteboard/1",
  ]);
  s.local({ files: { content: true, shared: true } });
  await flushRtc();
  expect(s.send.mock.calls.at(-1)![0]).toMatchObject({
    update: {
      kind: "patch",
      services: { "acme.whiteboard/1": null },
    },
  });
  s.events.dispatchEvent("messagechannelchange", "closed");
  s.events.dispatchEvent("messagechannelchange", "ready");
  await flushRtc();
  expect(s.send.mock.calls.at(-1)![0]).toMatchObject({
    update: {
      kind: "snapshot",
      services: {
        "files/1": { content: true, shared: true },
      },
    },
  });
});
it("waits for a complete baseline and merges an early patch into discovery", async () => {
  const s = setup({
    files: { content: true, shared: true },
    speedTest: { busy: false },
  });
  const ready = s.service.whenReady(s.session);
  s.patch(3, { speedTest: { busy: true } });
  expect(s.changed).not.toHaveBeenCalled();
  expect(s.service.get(s.session)).toBeUndefined();
  s.receive(1, {
    speedTest: { busy: false },
    files: { content: true, shared: true },
  });
  await expect(ready).resolves.toEqual({
    speedTest: { busy: true },
    files: { content: true, shared: true },
  });
});

it("falls back to a bounded full snapshot when withdrawals make a patch too large", async () => {
  const s = setup();
  await flushRtc();
  const oldServices = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [
      `old-${i}-${"x".repeat(100)}`,
      {},
    ]),
  );
  s.local(oldServices);
  await flushRtc();
  const next = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [
      `next-${i}`,
      { data: "x".repeat(430) },
    ]),
  );
  s.local(next);
  await flushRtc();
  const message = s.send.mock.calls.at(-1)![0];
  expect(message).toMatchObject({
    update: {
      kind: "snapshot",
      services: advertiseCapabilities(next),
    },
  });
  if (message.type !== "peer-capabilities")
    throw new Error("Missing snapshot");
  expect(validCapabilityUpdate(message.update)).toBe(true);
});
it("answers resync requests even while an identical initial snapshot is still being sent", async () => {
  const s = setup();
  s.receiveUpdate({ kind: "request-snapshot" });
  await flushRtc();
  expect(s.send).toHaveBeenCalledTimes(2);
  expect(s.send.mock.calls[1][0]).toMatchObject({
    update: { kind: "snapshot", revision: 2 },
  });
});
it("requests a fresh snapshot when incremental state exceeds bounds and cancels recovery after discovery", async () => {
  vi.useFakeTimers();
  const s = setup({ speedTest: { busy: false } });
  await flushRtc();
  s.receive(
    1,
    Object.fromEntries(
      Array.from({ length: 32 }, (_, i) => [
        `plugin-${i}`,
        {},
      ]),
    ),
  );
  s.patch(2, { speedTest: { busy: true } });
  await flushRtc();
  expect(s.service.get(s.session)).toBeUndefined();
  expect(s.send.mock.calls.at(-1)![0]).toMatchObject({
    update: { kind: "request-snapshot" },
  });
  const ready = s.service.whenReady(s.session);
  await vi.advanceTimersByTimeAsync(1000);
  s.receive(3, { speedTest: { busy: true } });
  await expect(ready).resolves.toEqual({
    speedTest: { busy: true },
  });
  expect(vi.getTimerCount()).toBe(0);
});
it("rejects discovery waiters and aborts queued sends on disconnect or disposal", async () => {
  const s = setup();
  const first = expect(
    s.service.whenReady(s.session),
  ).rejects.toThrow("interrupted");
  const signal = s.send.mock.calls[0][1]!.signal!;
  s.events.dispatchEvent("messagechannelchange", "closed");
  await first;
  expect(signal.aborted).toBe(true);
  const lifetime = new AbortController();
  const second = expect(
    s.service.whenReady(s.session, lifetime.signal),
  ).rejects.toThrow("cancelled");
  lifetime.abort(new Error("cancelled"));
  await second;
  const third = expect(
    s.service.whenReady(s.session),
  ).rejects.toThrow("interrupted");
  s.stop();
  await third;
  s.receive(1, {});
  expect(s.service.get(s.session)).toBeUndefined();
});

it("disables only unmatched features and applies versioned withdrawals without an extra handshake", async () => {
  const s = setup({
    messaging: {},
    files: { content: true, shared: true },
  });
  s.receive(1, {
    "messaging/2": { newFormat: true },
    "files/1": { content: true, shared: true },
  });
  await expect(
    s.service.require(s.session, ["messaging"]),
  ).rejects.toMatchObject({ code: "unsupported-protocol" });
  await expect(
    s.service.require(s.session, ["files"]),
  ).resolves.toBeUndefined();
  s.patch(2, { "files/1": null });
  await expect(
    s.service.require(s.session, ["files"]),
  ).rejects.toMatchObject({ code: "unsupported-protocol" });
  s.patch(3, { "messaging/1": {} });
  await expect(
    s.service.require(s.session, ["messaging"]),
  ).resolves.toBeUndefined();
  await flushRtc();
  expect(s.send).toHaveBeenCalledOnce();
});

it("settles discovery as unavailable for an unknown sync version and resets on reconnect", async () => {
  const s = setup();
  const ready = s.service.whenReady(s.session);
  s.events.dispatchEvent("message", {
    ...createSessionMessage(
      { clientId: "host", targetClientId: "viewer" },
      "peer-capabilities",
      { update: { kind: "request-snapshot" } },
    ),
    version: 2,
    update: { future: true },
  });
  await expect(ready).resolves.toEqual({});
  await expect(
    s.service.require(s.session, ["files"]),
  ).rejects.toMatchObject({ code: "unsupported-protocol" });
  s.receive(1, { files: { content: true, shared: true } });
  expect(s.service.get(s.session)).toEqual({});
  s.events.dispatchEvent("messagechannelchange", "closed");
  s.events.dispatchEvent("messagechannelchange", "ready");
  s.receive(1, { files: { content: true, shared: true } });
  await expect(
    s.service.require(s.session, ["files"]),
  ).resolves.toBeUndefined();
});

it("exposes the selected extension handler and never downgrades it within a connection", () => {
  const s = setup({
    "acme.board/1": {},
    "acme.board/2": {},
  });
  s.receive(1, {
    "acme.board/1": {},
    "acme.board/2": { newSchema: true },
  });
  expect(s.service.protocol(s.session, "acme.board")).toBe(
    "acme.board/2",
  );
  expect(s.service.get(s.session)).toEqual({
    "acme.board": { newSchema: true },
  });
  s.patch(2, { "acme.board/2": null });
  expect(
    s.service.protocol(s.session, "acme.board"),
  ).toBeUndefined();
  expect(s.service.get(s.session)).toEqual({});
  s.events.dispatchEvent("messagechannelchange", "closed");
  s.events.dispatchEvent("messagechannelchange", "ready");
  s.receive(1, { "acme.board/1": {} });
  expect(s.service.protocol(s.session, "acme.board")).toBe(
    "acme.board/1",
  );
});
it("retries a failed announcement with current state and cancels retry timers on teardown", async () => {
  vi.useFakeTimers();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const s = setup();
  await flushRtc();
  s.send.mockRejectedValueOnce(new Error("channel busy"));
  s.local({ speedTest: { busy: true } });
  await flushRtc();
  await vi.advanceTimersByTimeAsync(1000);
  expect(s.send.mock.calls.at(-1)![0]).toMatchObject({
    update: {
      kind: "snapshot",
      services: { "speedTest/1": { busy: true } },
    },
  });
  expect(vi.getTimerCount()).toBe(0);
  s.send.mockRejectedValueOnce(new Error("closed"));
  s.local({});
  await flushRtc();
  s.stop();
  expect(vi.getTimerCount()).toBe(0);
});
it("bounds the envelope without interpreting feature-version payloads", () => {
  const snapshot = {
    kind: "snapshot",
    generation: "generation",
    revision: 1,
    services: { future: { available: true } },
  };
  expect(validCapabilityUpdate(snapshot)).toBe(true);
  expect(
    validCapabilityUpdate({
      ...snapshot,
      services: { "acme.whiteboard/1": { mode: "edit" } },
    }),
  ).toBe(true);
  expect(
    validCapabilityUpdate({
      ...snapshot,
      kind: "patch",
      services: { clipboard: null },
    }),
  ).toBe(true);
  expect(
    validCapabilityUpdate({
      ...snapshot,
      services: { clipboard: null },
    }),
  ).toBe(false);
  expect(
    validCapabilityUpdate({ kind: "request-snapshot" }),
  ).toBe(true);
  expect(
    validCapabilityUpdate({
      kind: "request-snapshot",
      services: {},
    }),
  ).toBe(false);
  expect(
    validCapabilityUpdate({
      ...snapshot,
      kind: "patch",
      services: { "control/2": { host: true } },
    }),
  ).toBe(true);
  for (const services of [
    {
      control: {
        host: "true",
        request: true,
        occupancy: { state: "idle" },
      },
    },
    {
      control: {
        host: true,
        request: true,
        occupancy: {
          state: "controlled",
          clientId: "peer",
        },
      },
    },
    {
      screen: {
        decode: { video: ["bad-codec"], audio: null },
        multiScreen: true,
        trickleIce: true,
      },
    },
    { future: "x".repeat(17 * 1024) },
  ]) {
    const [name, value] = Object.entries(services)[0];
    expect(validCurrentCapability(name, value)).toBe(false);
  }
  for (const revision of [
    -1,
    0.1,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    expect(
      validCapabilityUpdate({ ...snapshot, revision }),
    ).toBe(false);
});

it("shares a stable connection generation until the main channel resets", async () => {
  const s = setup();
  const first = s.service.generation(s.session);
  expect(first).toBeTruthy();
  s.local({ automation: {} });
  expect(s.service.generation(s.session)).toBe(first);
  await flushRtc();
  s.events.dispatchEvent("messagechannelchange", "closed");
  const second = s.service.generation(s.session);
  expect(second).toBeTruthy();
  expect(second).not.toBe(first);
  s.events.dispatchEvent("messagechannelchange", "ready");
  expect(s.service.generation(s.session)).toBe(second);
  await flushRtc();
  expect(s.send.mock.calls.at(-1)?.[0]).toMatchObject({
    update: { kind: "snapshot", generation: second },
  });
  s.stop();
  expect(s.service.generation(s.session)).toBeUndefined();
  const dispose = s.service.bind(s.session, () => {});
  expect(s.service.generation(s.session)).not.toBe(second);
  dispose();
});
