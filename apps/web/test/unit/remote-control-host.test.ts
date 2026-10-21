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
function setup(
  policy?: RemoteControlPolicy,
  shortcut?: () => string,
) {
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
        pending: [],
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
  const host = new RemoteControlHost(
    platform,
    policy,
    shortcut,
  );
  return {
    host,
    api,
    unwatch,
    emit: (status: NativeControlStatus) =>
      receive?.(status),
  };
}
it.each([false, true])(
  "keeps automation authority independent of device remote-control policy (allow list: %s)",
  async (whitelistOnly) => {
    const decision = vi.fn((id: string) =>
      id === "paired-device"
        ? ("allow" as const)
        : ("deny" as const),
    );
    const { host, api, emit } = setup({
      whitelistOnly: () => whitelistOnly,
      decision,
      remember: vi.fn(),
    });
    host.start();
    await flush();
    const controlled = {
      pending: [],
      closed: false,
      sourceId: "screen",
      grantId: "grant",
    };
    emit({
      ...controlled,
      clientId: "paired-device",
      controllerKind: "remote",
    });
    await flush();
    expect(api.revoke).not.toHaveBeenCalled();
    // Both a verified device and a local MCP token use native automation consent.
    for (const clientId of ["paired-device", "mcp-token"]) {
      decision.mockReturnValue("deny");
      emit({
        ...controlled,
        clientId,
        controllerKind: "automation",
      });
      await flush();
      await host.policyChanged(clientId);
      expect(api.revoke).not.toHaveBeenCalled();
      expect(host.status().clientId).toBe(clientId);
      expect(() =>
        host.clipboardScope(clientId, "grant"),
      ).toThrow();
      await expect(
        host.requestScreen(
          "paired-device",
          "peer",
          new AbortController().signal,
        ),
      ).resolves.toBeUndefined();
    }
    // Explicit local stop still works for automation.
    await host.revoke();
    expect(api.revoke).toHaveBeenCalledTimes(1);
    // Missing metadata retains the legacy remote-control checks.
    emit({ ...controlled, clientId: "unpaired-device" });
    await flush();
    expect(api.revoke).toHaveBeenCalledTimes(2);
    host.close();
  },
);

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
    pending: [
      {
        consentId: "consent",
        clientId: "alice",
        sourceId: "screen",
      },
    ],
  });
  host.screen.share = vi.fn(async () => "other-screen");
  expect(host.status().pending).toEqual([]);
  expect(host.capability("bob").occupancy).toMatchObject({
    state: "pending",
    clientId: "alice",
  });
  await expect(
    host.requestScreen(
      "bob",
      "bob-generation",
      new AbortController().signal,
    ),
  ).resolves.toBeUndefined();
  expect(host.screen.share).not.toHaveBeenCalled();
  emit({ closed: false, clientId: "alice", pending: [] });
  finish();
  await flush();
  expect(host.status().clientId).toBe("alice");
  expect(api.approve).toHaveBeenCalledOnce();
  host.close();
});
it("reserves an approved avatar handoff against a competing native request, even with remembered permission", async () => {
  const { host, api, emit } = setup({
    decision: () => "allow",
    remember: vi.fn(),
  });
  host.screen.share = async () => "screen";
  host.start();
  await flush();
  await expect(
    host.requestScreen(
      "alice",
      "alice-generation",
      new AbortController().signal,
    ),
  ).resolves.toBe("screen");
  expect(host.capability("bob").occupancy).toEqual({
    state: "pending",
    clientId: "alice",
    sourceId: "screen",
  });
  emit({
    closed: false,
    clientId: null,
    pending: [
      {
        consentId: "competing",
        clientId: "bob",
        sourceId: "screen",
        peerGeneration: "bob-generation",
      },
    ],
  });
  await flush();
  expect(api.approve).toHaveBeenLastCalledWith(
    "owner-1",
    "competing",
    false,
  );
  expect(host.capability("bob").occupancy).toMatchObject({
    state: "pending",
    clientId: "alice",
  });
  emit({
    closed: false,
    clientId: null,
    pending: [
      {
        consentId: "handoff",
        clientId: "alice",
        sourceId: "screen",
        peerGeneration: "alice-generation",
      },
    ],
  });
  await flush();
  expect(api.approve).toHaveBeenLastCalledWith(
    "owner-1",
    "handoff",
    true,
  );
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
    pending: [],
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
      pending: [],
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
    pending: [],
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
    pending: [],
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
      pending: [
        {
          consentId: "pending",
          clientId: "alice",
          sourceId: "screen",
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(500);
    if (decision === "allow")
      expect(api.approve).toHaveBeenCalledWith(
        "owner-1",
        "pending",
        true,
      );
    else expect(api.approve).not.toHaveBeenCalled();
    expect(host.status().pending).toEqual([]);
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
  const pending = host.status().pending[0]!;
  await host.approve(pending.consentId, true);
  expect(await result).toBe("screen");
  expect(remember).not.toHaveBeenCalled();
  emit({
    closed: false,
    clientId: null,
    pending: [
      {
        consentId: "native",
        clientId: "alice",
        sourceId: "screen",
        peerGeneration: "peer",
      },
    ],
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
    pending: [
      {
        consentId: "next",
        clientId: "alice",
        sourceId: "screen",
        peerGeneration: "peer",
      },
    ],
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(host.status().pending[0]?.consentId).toBe("next");
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
  expect(host.status().pending).toEqual([]);
  emit({
    closed: false,
    pending: [],
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
    pending: [
      {
        consentId: "pending",
        clientId: "alice",
        sourceId: "screen",
      },
    ],
  });
  expect(host.status().pending[0]?.consentId).toBe(
    "pending",
  );
  decision = "allow";
  await host.policyChanged("alice");
  expect(api.approve).toHaveBeenCalledWith(
    "owner-1",
    "pending",
    true,
  );
  expect(host.status().pending).toEqual([]);
  host.close();
});

it("silently hides a pending native request when its permission changes to deny", async () => {
  let decision: "deny" | undefined;
  const { host, api, emit } = setup({
    decision: () => decision,
    remember: vi.fn(),
  });
  host.start();
  await flush();
  emit({
    closed: false,
    clientId: null,
    pending: [
      {
        consentId: "pending",
        clientId: "alice",
        sourceId: "screen",
      },
    ],
  });
  decision = "deny";
  await host.policyChanged("alice");
  expect(api.approve).not.toHaveBeenCalled();
  expect(host.status().pending).toEqual([]);
  expect(
    await host.context("peer", "alice"),
  ).toBeUndefined();
  host.close();
});

it("releases an approved avatar reservation when the requester is blocked before native handoff", async () => {
  let decision: "allow" | "deny" = "allow";
  const { host } = setup({
    decision: (clientId) =>
      clientId === "alice" ? decision : undefined,
    remember: vi.fn(),
  });
  host.screen.share = vi.fn(async () => "screen");
  host.start();
  await flush();
  await expect(
    host.requestScreen(
      "alice",
      "alice-generation",
      new AbortController().signal,
    ),
  ).resolves.toBe("screen");
  decision = "deny";
  await host.policyChanged("alice");
  expect(host.capability("bob").occupancy).toEqual({
    state: "idle",
  });
  expect(
    host.screen.consume(
      "alice",
      "alice-generation",
      "screen",
    ),
  ).toBe(false);
  host.close();
});

it("uses the saved emergency chord at startup and the latest chord after recovery", async () => {
  vi.useFakeTimers();
  let shortcut = "ctrl-shift-f8";
  const { host, api, emit } = setup(
    undefined,
    () => shortcut,
  );
  host.start();
  await flush();
  expect(api.open).toHaveBeenLastCalledWith(
    "ctrl-shift-f8",
  );
  shortcut = "ctrl-alt-f9";
  emit({ closed: true, pending: [], clientId: null });
  await flush();
  await vi.advanceTimersByTimeAsync(1000);
  await flush();
  expect(api.open).toHaveBeenLastCalledWith("ctrl-alt-f9");
  host.close();
});

it("selects any avatar request and declines competing native requests before sharing completes", async () => {
  const { host, api, emit } = setup();
  let finish!: (source: string) => void;
  host.screen.share = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  host.start();
  await flush();
  const alice = host.requestScreen(
    "alice",
    "a",
    new AbortController().signal,
  );
  const bob = host.requestScreen(
    "bob",
    "b",
    new AbortController().signal,
  );
  await flush();
  emit({
    closed: false,
    clientId: null,
    pending: [
      {
        consentId: "native",
        clientId: "carol",
        sourceId: "screen",
      },
    ],
  });
  expect(
    host.status().pending.map((p) => p.clientId),
  ).toEqual(["alice", "bob", "carol"]);
  expect(host.capability("dave").occupancy).toEqual({
    state: "idle",
  });
  const pending = host.status().pending;
  const selected = host.approve(pending[1].consentId, true);
  await host.approve(pending[0].consentId, true);
  await host.approve("native", true);
  await expect(alice).resolves.toBeUndefined();
  expect(api.approve).toHaveBeenCalledWith(
    "owner-1",
    "native",
    false,
  );
  expect(host.capability("carol").occupancy).toMatchObject({
    state: "pending",
    clientId: "bob",
  });
  await expect(
    host.requestScreen(
      "dave",
      "d",
      new AbortController().signal,
    ),
  ).resolves.toBeUndefined();
  finish("screen");
  await selected;
  await expect(bob).resolves.toBe("screen");
  expect(host.screen.share).toHaveBeenCalledOnce();
  host.close();
});

it("locks native selection before IPC and cancels avatar requests despite simultaneous answers", async () => {
  const { host, api, emit } = setup();
  host.screen.share = vi.fn(async () => "screen");
  let finish!: () => void;
  api.approve.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  host.start();
  await flush();
  const avatar = host.requestScreen(
    "alice",
    "a",
    new AbortController().signal,
  );
  await flush();
  emit({
    closed: false,
    clientId: null,
    pending: [
      {
        consentId: "bob",
        clientId: "bob",
        sourceId: "screen",
      },
      {
        consentId: "carol",
        clientId: "carol",
        sourceId: "screen",
      },
    ],
  });
  const alice = host.status().pending[0];
  const selected = host.approve("carol", true);
  await host.approve("bob", true);
  await host.approve(alice.consentId, true);
  expect(api.approve).toHaveBeenCalledWith(
    "owner-1",
    "carol",
    true,
  );
  await expect(avatar).resolves.toBeUndefined();
  expect(host.screen.share).not.toHaveBeenCalled();
  expect(host.status().pending).toEqual([]);
  emit({
    closed: false,
    clientId: "carol",
    sourceId: "screen",
    pending: [],
  });
  finish();
  await selected;
  expect(host.capability("bob").occupancy).toMatchObject({
    state: "controlled",
    clientId: "carol",
  });
  emit({ closed: false, clientId: null, pending: [] });
  expect(host.capability("bob").occupancy).toEqual({
    state: "idle",
  });
  host.close();
});

it("uses the allow list for disclosure, sharing and native contexts and revokes when removed", async () => {
  let decision: "allow" | "deny" | undefined;
  const { host, api, emit } = setup({
    whitelistOnly: () => true,
    decision: () => decision,
    remember: vi.fn(),
  });
  host.screen.share = vi.fn(async () => "screen");
  host.start();
  await flush();
  expect(host.exposes("alice")).toBe(false);
  expect(
    await host.context("peer", "alice"),
  ).toBeUndefined();
  await expect(
    host.requestScreen(
      "alice",
      "peer",
      new AbortController().signal,
    ),
  ).resolves.toBeUndefined();
  expect(host.status().pending).toEqual([]);
  expect(host.screen.share).not.toHaveBeenCalled();
  decision = "allow";
  await host.policyChanged("alice");
  expect(host.exposes("alice")).toBe(true);
  expect(await host.context("peer", "alice")).toMatchObject(
    { clientId: "alice" },
  );
  emit({
    pending: [],
    closed: false,
    clientId: "alice",
    sourceId: "screen",
  });
  decision = undefined;
  await host.policyChanged("alice");
  expect(host.exposes("alice")).toBe(false);
  expect(api.revoke).toHaveBeenCalledWith("owner-1");
  expect(
    await host.context("peer", "alice"),
  ).toBeUndefined();
  host.close();
});
