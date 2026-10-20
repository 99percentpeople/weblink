// @vitest-environment jsdom
import {
  cleanup,
  render,
  waitFor,
} from "@solidjs/testing-library";
import {
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from "vitest";
import { webcrypto } from "node:crypto";
import { createAutomation } from "@/libs/state/create-automation";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import type { NativeAutomation } from "@weblink/platform";
import type {
  ToolCall,
  ToolResult,
} from "@weblink/automation";
import type { PeerSession } from "@/libs/domain/session";
const fixture = vi.hoisted(() => ({
  native: undefined as unknown as NativeAutomation,
  sessions: {} as Record<string, PeerSession>,
  receive: true,
  incoming: undefined as
    | undefined
    | ((
        call: ToolCall,
        signal: AbortSignal,
      ) => Promise<ToolResult>),
  advertise: vi.fn(),
  handle: vi.fn(
    async (
      _call: ToolCall,
      _signal: AbortSignal,
    ): Promise<Record<string, unknown>> => ({}),
  ),
}));
vi.mock("@/libs/platform/runtime", () => ({
  platform: {
    get automation() {
      return fixture.native;
    },
  },
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {
    get sessions() {
      return fixture.sessions;
    },
    clientViewData: { peer: { name: "Peer" } },
    capabilities: { get: () => ({ automation: {} }) },
    canReceive: () => fixture.receive,
    canShareScreen: () => true,
    setAutomationEnabled: fixture.advertise,
  },
}));
vi.mock("@/libs/application/automation/handlers", () => ({
  automationHandlers: () => fixture.handle,
  diagnosticSources: () => [],
}));
vi.mock("@/libs/application/automation/peer-link", () => ({
  AutomationPeerLink: class {
    readonly lifetime = new AbortController();
    readonly ready = Promise.resolve();
    readonly fingerprint = "a".repeat(64);
    constructor(
      _channel: unknown,
      incoming: typeof fixture.incoming,
      _changed: unknown,
      private closed: () => void,
    ) {
      fixture.incoming = incoming;
    }
    close() {
      if (!this.lifetime.signal.aborted) {
        this.lifetime.abort();
        this.closed();
      }
    }
  },
}));
const snapshot = () => ({
  enabled: false,
  endpoint: "",
  server: { host: "127.0.0.1", port: 32100 },
  serverPending: false,
  clients: [],
  pending: [],
  grants: [],
  audit: [],
  jobs: [],
});
const mount = () => {
  let runtime!: ReturnType<typeof createAutomation>;
  const view = render(() => {
    runtime = createAutomation({} as AppStateContextProps);
    return null;
  });
  return { runtime, ...view };
};
beforeEach(() => {
  fixture.handle.mockReset().mockResolvedValue({});
  vi.stubGlobal("crypto", webcrypto);
  fixture.sessions = {};
  fixture.receive = true;
  fixture.incoming = undefined;
  fixture.native = {
    open: vi.fn(async () => "epoch"),
    close: vi.fn(async () => {}),
    heartbeat: vi.fn(async () => {}),
    snapshot: vi.fn(async () => snapshot()),
    configure: vi.fn(async () => {}),
    peer: vi.fn(async () => "native-peer"),
    peerPolicy: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    call: vi.fn(async () => ({ ok: true, data: {} })),
    cancel: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
  } as unknown as NativeAutomation;
  setAppState("options", "automationEnabled", false);
  setAppState(
    "options",
    "clientConfigs",
    "peer",
    undefined,
  );
});
it("aborts application work immediately on a native cancellation event", async () => {
  const view = mount();
  await waitFor(() =>
    expect(view.runtime.ready()).toBe(true),
  );
  await view.runtime.configure(true);
  let active!: AbortSignal;
  let finish!: () => void;
  fixture.handle.mockImplementationOnce(
    async (_, signal) => {
      active = signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      signal.throwIfAborted();
      return {};
    },
  );
  const receive = vi.mocked(fixture.native.open).mock
    .calls[0][0];
  receive({
    kind: "call",
    id: "active",
    principal: { id: "token", label: "Agent", kind: "mcp" },
    call: {
      name: "screen.start",
      arguments: { target: "local", sourceId: "screen" },
    },
  });
  await waitFor(() => expect(active).toBeDefined());
  expect(active.aborted).toBe(false);
  receive({ kind: "cancel", id: "active" });
  expect(active.aborted).toBe(true);
  finish();
  await waitFor(() =>
    expect(fixture.native.finish).toHaveBeenCalledWith(
      "epoch",
      "active",
      {
        ok: false,
        error: { code: "CANCELLED", message: "CANCELLED" },
      },
    ),
  );
});
it.each([false, true])(
  "a delayed snapshot preserves newer calls and late cleanup cannot finish a replacement (reuse=%s)",
  async (reuse) => {
    const view = mount();
    await waitFor(() =>
      expect(view.runtime.ready()).toBe(true),
    );
    await view.runtime.configure(true);
    const signals = new Map<string, AbortSignal>();
    const finish = new Map<string, () => void>();
    fixture.handle.mockImplementation(
      async (call, signal) => {
        const source = String(call.arguments.sourceId);
        signals.set(source, signal);
        await new Promise<void>((resolve) => {
          finish.set(source, resolve);
        });
        signal.throwIfAborted();
        return { source };
      },
    );
    const receive = vi.mocked(fixture.native.open).mock
      .calls[0][0];
    const request = (id: string, sourceId: string) =>
      receive({
        kind: "call",
        id,
        principal: {
          id: "token",
          label: "Agent",
          kind: "mcp",
        },
        call: {
          name: "screen.start",
          arguments: { target: "local", sourceId },
        },
      });
    request("old", "old");
    await waitFor(() =>
      expect(signals.has("old")).toBe(true),
    );
    let resolveSnapshot!: (value: unknown) => void;
    vi.mocked(
      fixture.native.snapshot,
    ).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve;
        }),
    );
    await waitFor(
      () => expect(resolveSnapshot).toBeDefined(),
      { timeout: 2500 },
    );
    const nextId = reuse ? "old" : "new";
    if (reuse) receive({ kind: "cancel", id: "old" });
    request(nextId, "new");
    await waitFor(() =>
      expect(signals.has("new")).toBe(true),
    );
    try {
      resolveSnapshot({ ...snapshot(), activeCalls: [] });
      await waitFor(() =>
        expect(signals.get("old")!.aborted).toBe(true),
      );
      expect(signals.get("new")!.aborted).toBe(false);
      finish.get("old")!();
      // Let the old native callback complete before the replacement.
      await new Promise((resolve) =>
        setTimeout(resolve, 0),
      );
      if (reuse)
        expect(
          fixture.native.finish,
        ).not.toHaveBeenCalled();
      else
        expect(fixture.native.finish).toHaveBeenCalledWith(
          "epoch",
          "old",
          {
            ok: false,
            error: {
              code: "CANCELLED",
              message: "CANCELLED",
            },
          },
        );
      expect(signals.get("new")!.aborted).toBe(false);
      finish.get("new")!();
      await waitFor(() =>
        expect(fixture.native.finish).toHaveBeenCalledWith(
          "epoch",
          nextId,
          { ok: true, data: { source: "new" } },
        ),
      );
      if (reuse)
        expect(fixture.native.finish).toHaveBeenCalledTimes(
          1,
        );
    } finally {
      finish.forEach((resolve) => resolve());
    }
  },
);
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
it("restores enabled state only after native initialization and retains it across cleanup", async () => {
  setAppState("options", "automationEnabled", true);
  let resolve!: (epoch: string) => void;
  vi.mocked(fixture.native.open).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const first = mount();
  expect(first.runtime.ready()).toBe(false);
  expect(fixture.native.configure).not.toHaveBeenCalled();
  resolve("epoch");
  await waitFor(() =>
    expect(first.runtime.enabled()).toBe(true),
  );
  expect(fixture.native.configure).toHaveBeenCalledWith(
    "epoch",
    true,
  );
  first.unmount();
  expect(appState.options.automationEnabled).toBe(true);
  expect(fixture.native.close).toHaveBeenCalledWith(
    "epoch",
  );
  const second = mount();
  await waitFor(() =>
    expect(second.runtime.enabled()).toBe(true),
  );
  await second.runtime.configure(false);
  second.unmount();
  expect(appState.options.automationEnabled).toBe(false);
  vi.mocked(fixture.native.configure).mockClear();
  const third = mount();
  await waitFor(() =>
    expect(third.runtime.ready()).toBe(true),
  );
  expect(third.runtime.enabled()).toBe(false);
  expect(fixture.native.configure).not.toHaveBeenCalled();
});
it("keeps the saved enabled preference when listener startup fails", async () => {
  setAppState("options", "automationEnabled", true);
  vi.mocked(fixture.native.configure).mockRejectedValueOnce(
    new Error("PORT_IN_USE"),
  );
  const { runtime } = mount();
  await waitFor(() => expect(runtime.ready()).toBe(true));
  expect(runtime.enabled()).toBe(false);
  expect(runtime.error()).toContain("PORT_IN_USE");
  expect(runtime.configuredEnabled()).toBe(true);
  expect(appState.options.automationEnabled).toBe(true);
  expect(fixture.advertise).not.toHaveBeenCalledWith(true);
  await runtime.configure(false);
  expect(runtime.configuredEnabled()).toBe(false);
  expect(appState.options.automationEnabled).toBe(false);
});
it("does not start the listener if the owner closes while native initialization is pending", async () => {
  setAppState("options", "automationEnabled", true);
  let resolve!: (epoch: string) => void;
  vi.mocked(fixture.native.open).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = mount();
  view.unmount();
  resolve("late");
  await waitFor(() =>
    expect(fixture.native.close).toHaveBeenCalledWith(
      "late",
    ),
  );
  expect(fixture.native.configure).not.toHaveBeenCalled();
  expect(appState.options.automationEnabled).toBe(true);
});
function peer() {
  fixture.sessions.peer = {
    clientId: "a",
    targetClientId: "peer",
    isMessageChannelReady: true,
    peerConnection: {},
    addEventListener() {},
    createChannel: async () => ({ close() {} }),
  } as unknown as PeerSession;
}
const incoming = () =>
  fixture.incoming!(
    {
      name: "diagnostics.snapshot",
      arguments: { target: "local" },
    },
    new AbortController().signal,
  );
it("applies verified device policies before calls, updates them live, and retains them after disconnect", async () => {
  peer();
  setAppState("options", "clientConfigs", "peer", {
    provideFileList: false,
    automation: { "diagnostics.read": "allow" },
  });
  const view = mount();
  await waitFor(() =>
    expect(view.runtime.ready()).toBe(true),
  );
  await view.runtime.configure(true);
  await waitFor(() =>
    expect(fixture.incoming).toBeDefined(),
  );
  await incoming();
  expect(fixture.native.peerPolicy).toHaveBeenCalledWith(
    "epoch",
    "native-peer",
    { "diagnostics.read": "allow" },
  );
  expect(view.runtime.principalPeerId("native-peer")).toBe(
    "peer",
  );
  expect(
    vi.mocked(fixture.native.peerPolicy).mock
      .invocationCallOrder[0],
  ).toBeLessThan(
    vi.mocked(fixture.native.call).mock
      .invocationCallOrder[0],
  );
  setAppState(
    "options",
    "clientConfigs",
    "peer",
    "automation",
    "diagnostics.read",
    "deny",
  );
  await waitFor(() =>
    expect(
      fixture.native.peerPolicy,
    ).toHaveBeenLastCalledWith("epoch", "native-peer", {
      "diagnostics.read": "deny",
    }),
  );
  view.unmount();
  await waitFor(() =>
    expect(fixture.native.disconnect).toHaveBeenCalledWith(
      "epoch",
      "native-peer",
    ),
  );
  expect(
    appState.options.clientConfigs.peer?.automation?.[
      "diagnostics.read"
    ],
  ).toBe("deny");
});
it("never applies a saved allow policy when the device cannot receive authenticated content", async () => {
  peer();
  const view = mount();
  await waitFor(() =>
    expect(view.runtime.ready()).toBe(true),
  );
  await view.runtime.configure(true);
  await waitFor(() =>
    expect(fixture.incoming).toBeDefined(),
  );
  fixture.receive = false;
  setAppState("options", "clientConfigs", "peer", {
    provideFileList: false,
    automation: { "diagnostics.read": "allow" },
  });
  expect(await incoming()).toMatchObject({
    ok: false,
    error: { code: "PERMISSION_DENIED" },
  });
  expect(fixture.native.peerPolicy).not.toHaveBeenCalled();
  expect(fixture.native.call).not.toHaveBeenCalled();
});
it("rejects a stale channel when a same-id session replaces it during native registration", async () => {
  peer();
  let resolve!: (id: string) => void;
  vi.mocked(fixture.native.peer).mockImplementationOnce(
    () =>
      new Promise((r) => {
        resolve = r;
      }),
  );
  const view = mount();
  await waitFor(() =>
    expect(view.runtime.ready()).toBe(true),
  );
  await view.runtime.configure(true);
  await waitFor(() =>
    expect(fixture.incoming).toBeDefined(),
  );
  const request = incoming();
  const rejected = expect(request).rejects.toThrow(
    "TARGET_DISCONNECTED",
  );
  await waitFor(() =>
    expect(fixture.native.peer).toHaveBeenCalled(),
  );
  peer();
  resolve("stale-peer");
  await rejected;
  expect(fixture.native.peerPolicy).not.toHaveBeenCalled();
  expect(fixture.native.call).not.toHaveBeenCalled();
  expect(fixture.native.disconnect).toHaveBeenCalledWith(
    "epoch",
    "stale-peer",
  );
});

it("waits for a policy changed during registration before admitting the call", async () => {
  peer();
  setAppState("options", "clientConfigs", "peer", {
    provideFileList: false,
    automation: { "diagnostics.read": "allow" },
  });
  let release!: () => void;
  vi.mocked(
    fixture.native.peerPolicy,
  ).mockImplementationOnce(
    () =>
      new Promise<void>((r) => {
        release = r;
      }),
  );
  const view = mount();
  await waitFor(() =>
    expect(view.runtime.ready()).toBe(true),
  );
  await view.runtime.configure(true);
  await waitFor(() =>
    expect(fixture.incoming).toBeDefined(),
  );
  const request = incoming();
  await waitFor(() =>
    expect(fixture.native.peerPolicy).toHaveBeenCalledTimes(
      1,
    ),
  );
  setAppState(
    "options",
    "clientConfigs",
    "peer",
    "automation",
    "diagnostics.read",
    "deny",
  );
  expect(fixture.native.call).not.toHaveBeenCalled();
  release();
  await request;
  expect(
    fixture.native.peerPolicy,
  ).toHaveBeenLastCalledWith("epoch", "native-peer", {
    "diagnostics.read": "deny",
  });
  expect(
    vi.mocked(fixture.native.peerPolicy).mock
      .invocationCallOrder[1],
  ).toBeLessThan(
    vi.mocked(fixture.native.call).mock
      .invocationCallOrder[0],
  );
});
it("does not reuse an already registered authority after a same-id session replacement", async () => {
  peer();
  setAppState("options", "clientConfigs", "peer", {
    provideFileList: false,
    automation: { "diagnostics.read": "allow" },
  });
  const view = mount();
  await waitFor(() =>
    expect(view.runtime.ready()).toBe(true),
  );
  await view.runtime.configure(true);
  await waitFor(() =>
    expect(fixture.incoming).toBeDefined(),
  );
  await incoming();
  peer();
  await expect(incoming()).rejects.toThrow(
    "TARGET_DISCONNECTED",
  );
  expect(fixture.native.call).toHaveBeenCalledTimes(1);
  view.unmount();
  expect(
    appState.options.clientConfigs.peer?.automation?.[
      "diagnostics.read"
    ],
  ).toBe("allow");
});
