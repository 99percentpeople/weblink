import { afterEach, expect, it, vi } from "vitest";
import {
  RemoteControlHost,
  type RemoteControlPolicy,
} from "@/libs/application/remote-control-host";
import type {
  PlatformRuntime,
  NativeControlStatus,
} from "@weblink/platform";
afterEach(() => vi.useRealTimers());
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function setup(policy?: RemoteControlPolicy) {
  let next = 0;
  let receive:
    | ((status: NativeControlStatus) => void)
    | undefined;
  const unwatch = vi.fn();
  const api = {
    open: vi.fn(async () => `owner-${++next}`),
    end: vi.fn(async () => {}),
    status: vi.fn(
      async (): Promise<NativeControlStatus> => ({
        pending: null,
        clientId: null,
        closed: false,
      }),
    ),
    approve: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    watch: vi.fn(
      async (
        _owner: string,
        onStatus: (status: NativeControlStatus) => void,
      ): Promise<() => void> => {
        receive = onStatus;
        onStatus(await api.status());
        return unwatch;
      },
    ),
  };
  const platform = {
    remoteControl: api,
    getCapabilities: vi.fn(async () => ({
      remoteInput: true,
    })),
  } as unknown as PlatformRuntime;
  const host = new RemoteControlHost(platform, policy);
  return {
    host,
    api,
    unwatch,
    emit: (status: NativeControlStatus) =>
      receive?.(status),
  };
}
it("does not let an asynchronous automatic approval overwrite a newer native snapshot", async () => {
  const { host, api, emit } = setup({
    decision: () => "allow",
    remember: vi.fn(),
  });
  let finish!: () => void;
  api.approve.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  host.start();
  await flush();
  emit({
    closed: false,
    clientId: null,
    pending: {
      consentId: "consent",
      clientId: "alice",
      sourceId: "screen",
    },
  });
  emit({ closed: false, clientId: "alice", pending: null });
  finish();
  await flush();
  expect(host.status().clientId).toBe("alice");
  expect(api.approve).toHaveBeenCalledOnce();
  host.close();
});
it("disposes a watcher that finishes registering after leave and ignores its late events", async () => {
  const { host, api, unwatch } = setup();
  let finish!: (close: () => void) => void;
  let receive!: (status: NativeControlStatus) => void;
  api.watch.mockImplementationOnce((_owner, callback) => {
    receive = callback;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  host.start();
  await flush();
  host.close();
  receive({
    closed: false,
    clientId: "stale",
    pending: null,
  });
  finish(unwatch);
  await flush();
  expect(unwatch).toHaveBeenCalledOnce();
  expect(host.status()).toMatchObject({
    closed: true,
    clientId: null,
  });
});
it("reopens a failed worker repeatedly with new owners and fresh consent, and cancels recovery on leave", async () => {
  vi.useFakeTimers();
  const { host, api, emit } = setup();
  host.start();
  await flush();
  for (let i = 0; i < 4; i++) {
    const before = await host.context("peer", "alice");
    emit({
      pending: null,
      clientId: "alice",
      closed: true,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(host.status().clientId).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    const after = await host.context("peer", "alice");
    expect(after?.ownerId).not.toBe(before?.ownerId);
    expect(api.approve).not.toHaveBeenCalled();
  }
  emit({
    pending: null,
    clientId: null,
    closed: true,
  });
  await vi.advanceTimersByTimeAsync(500);
  const opens = api.open.mock.calls.length;
  host.close();
  await vi.advanceTimersByTimeAsync(60000);
  expect(api.open).toHaveBeenCalledTimes(opens);
});
it("subscribes once without idle polling and closes the subscription on leave", async () => {
  vi.useFakeTimers();
  const { host, api, unwatch } = setup();
  host.start();
  await flush();
  expect(await host.context("peer", "client")).toEqual({
    ownerId: "owner-1",
    peerGeneration: "peer",
    clientId: "client",
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.status).toHaveBeenCalledOnce();
  expect(api.watch).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
  host.close();
  expect(api.end).toHaveBeenCalledWith("owner-1");
  await vi.advanceTimersByTimeAsync(2000);
  expect(api.status).toHaveBeenCalledOnce();
  expect(unwatch).toHaveBeenCalledOnce();
  host.start();
  await flush();
  expect(
    await host.context("peer", "client"),
  ).toMatchObject({ ownerId: "owner-2" });
  host.close();
});
it("late native open completion cannot carry permission into another room", async () => {
  const { host, api } = setup();
  let finish!: (id: string) => void;
  api.open.mockImplementationOnce(
    () => new Promise((r) => (finish = r)),
  );
  host.start();
  await flush();
  host.start();
  finish("old-owner");
  await flush();
  expect(api.end).toHaveBeenCalledWith("old-owner");
  expect(
    await host.context("peer", "client"),
  ).toMatchObject({ ownerId: "owner-1" });
  host.close();
});
it("retries a failed subscription without ending the owner or requiring new approval", async () => {
  vi.useFakeTimers();
  const warning = vi
    .spyOn(console, "warn")
    .mockImplementation(() => {});
  const { host, api, emit } = setup();
  api.watch.mockRejectedValueOnce(
    new Error("temporary IPC failure"),
  );
  host.start();
  await flush();
  await vi.advanceTimersByTimeAsync(500);
  expect(await host.capabilities()).toEqual({
    request: true,
    host: true,
  });
  expect(api.end).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(api.watch).toHaveBeenCalledTimes(2);
  expect(host.status().closed).toBe(false);
  emit({
    pending: null,
    clientId: null,
    closed: true,
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(host.status().closed).toBe(true);
  expect(api.end).toHaveBeenCalledWith("owner-1");
  expect(api.open).toHaveBeenCalledTimes(1);
  host.close();
  warning.mockRestore();
});

it.each(["allow", "deny"] as const)(
  "enforces a saved %s decision without presenting the native request",
  async (decision) => {
    vi.useFakeTimers();
    const { host, api, emit } = setup({
      decision: () => decision,
      remember: vi.fn(),
    });
    host.start();
    await flush();
    emit({
      closed: false,
      clientId: null,
      pending: {
        consentId: "pending",
        clientId: "alice",
        sourceId: "screen",
      },
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(api.approve).toHaveBeenCalledWith(
      "owner-1",
      "pending",
      decision === "allow",
    );
    expect(host.status().pending).toBeNull();
    expect((await host.capabilities("alice")).host).toBe(
      decision === "allow",
    );
    expect(
      Boolean(await host.context("peer", "alice")),
    ).toBe(decision === "allow");
    host.close();
  },
);

it("remembers only the selected answer and automatically approves the subsequent matching screen request", async () => {
  vi.useFakeTimers();
  const remember = vi.fn();
  const { host, api, emit } = setup({
    decision: () => undefined,
    remember,
  });
  host.start();
  await flush();
  host.screen.share = vi.fn(async () => "screen");
  const result = host.requestScreen(
    "alice",
    "peer",
    new AbortController().signal,
  );
  await flush();
  expect(host.screen.share).not.toHaveBeenCalled();
  const pending = host.status().pending!;
  await host.approve(pending.consentId, true);
  expect(await result).toBe("screen");
  expect(remember).not.toHaveBeenCalled();
  emit({
    closed: false,
    clientId: null,
    pending: {
      consentId: "native",
      clientId: "alice",
      sourceId: "screen",
      peerGeneration: "peer",
    },
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(api.approve).toHaveBeenCalledWith(
    "owner-1",
    "native",
    true,
  );
  emit({
    closed: false,
    clientId: null,
    pending: {
      consentId: "next",
      clientId: "alice",
      sourceId: "screen",
      peerGeneration: "peer",
    },
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(host.status().pending?.consentId).toBe("next");
  await host.approve("stale", false, true);
  expect(remember).not.toHaveBeenCalled();
  await host.approve("next", false, true);
  expect(remember).toHaveBeenCalledWith("alice", "deny");
  host.close();
});

it("auto-starts sharing only for allowed clients and revokes an active client when blocked", async () => {
  vi.useFakeTimers();
  let decision: "allow" | "deny" = "allow";
  const { host, api, emit } = setup({
    decision: () => decision,
    remember: vi.fn(),
  });
  host.start();
  await flush();
  host.screen.share = vi.fn(async () => "screen");
  expect(
    await host.requestScreen(
      "alice",
      "peer",
      new AbortController().signal,
    ),
  ).toBe("screen");
  expect(host.status().pending).toBeNull();
  emit({
    closed: false,
    pending: null,
    clientId: "alice",
  });
  await vi.advanceTimersByTimeAsync(500);
  decision = "deny";
  await host.policyChanged("alice");
  expect(api.revoke).toHaveBeenCalledWith("owner-1");
  expect(
    await host.requestScreen(
      "alice",
      "peer",
      new AbortController().signal,
    ),
  ).toBeUndefined();
  expect(host.screen.share).toHaveBeenCalledTimes(1);
  host.close();
});

it("applies a newly saved allow rule to a pending native request without waiting for another event", async () => {
  let decision: "allow" | undefined;
  const { host, api, emit } = setup({
    decision: () => decision,
    remember: vi.fn(),
  });
  host.start();
  await flush();
  emit({
    closed: false,
    clientId: null,
    pending: {
      consentId: "pending",
      clientId: "alice",
      sourceId: "screen",
    },
  });
  expect(host.status().pending?.consentId).toBe("pending");
  decision = "allow";
  await host.policyChanged("alice");
  expect(api.approve).toHaveBeenCalledWith(
    "owner-1",
    "pending",
    true,
  );
  expect(host.status().pending).toBeNull();
  host.close();
});
