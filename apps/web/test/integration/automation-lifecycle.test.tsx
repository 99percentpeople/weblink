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
import { For } from "solid-js";
import { createAutomation } from "@/libs/state/create-automation";
import { AutomationScreenShares } from "@/libs/application/automation/screen-sharing";
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
  configureShortcut: vi.fn(async (_shortcut: string) => {}),
  generation: "connection-1",
  closeLink: undefined as (() => void) | undefined,
  events: new EventTarget(),
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
  discovery: vi.fn(),
  setController: vi.fn(),
  remoteCall:
    vi.fn<
      (
        call: ToolCall,
        signal: AbortSignal,
      ) => Promise<ToolResult>
    >(),
  handle: vi.fn(
    async (
      _call: ToolCall,
      _signal: AbortSignal,
    ): Promise<Record<string, unknown>> => ({}),
  ),
}));
vi.mock("@/libs/platform/runtime", () => ({
  platform: {
    kind: "desktop",
    remoteControl: {
      configureShortcut: fixture.configureShortcut,
    },
    getCapabilities: async () => ({
      runtime: "desktop",
      os: "windows",
      version: "1.2.3",
      nativeScreenCapture: true,
      displayRefreshRates: [60],
      remoteInput: true,
    }),
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
    capabilities: {
      generation: () => fixture.generation,
      get: () => ({
        automation: {},
        identity: { receiveContent: true },
      }),
    },
    canReceive: () => fixture.receive,
    canShareScreen: () => true,
    setAutomationEnabled: fixture.advertise,
    setDiagnosticsReady: fixture.discovery,
    setAutomationController: fixture.setController,
  },
}));
vi.mock("@/libs/application/automation/handlers", () => ({
  automationHandlers: () => fixture.handle,
  diagnosticSources: () => [],
}));
vi.mock("@/libs/application/automation/peer-link", () => ({
  AUTOMATION_CHANNEL: "weblink-automation/1",
  AutomationPeerLink: class {
    readonly lifetime = new AbortController();
    readonly ready = Promise.resolve();
    readonly connected = true;
    call = fixture.remoteCall;
    constructor(
      _channel: unknown,
      incoming: typeof fixture.incoming,
      _changed: unknown,
      private closed: () => void,
    ) {
      fixture.incoming = incoming;
      fixture.closeLink = () => this.close();
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
  mcpEnabled: false,
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
it("announces the actual OS automation switch independently of the MCP controller switch", async () => {
  const { runtime } = mount();
  await waitFor(() => expect(runtime.ready()).toBe(true));
  await runtime.configureMcp(true);
  await waitFor(() =>
    expect(fixture.discovery).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({
        runtime: "desktop",
        os: "windows",
        appVersion: "1.2.3",
        automationEnabled: false,
      }),
    ),
  );
  const tools =
    fixture.discovery.mock.lastCall?.[1].supportedTools;
  expect(tools).toContain("commands.run");
  await runtime.configure(true);
  await waitFor(() =>
    expect(fixture.discovery).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({
        automationEnabled: true,
        supportedTools: tools,
      }),
    ),
  );
  await runtime.configure(false);
  await waitFor(() =>
    expect(fixture.discovery).toHaveBeenLastCalledWith(
      true,
      expect.objectContaining({
        automationEnabled: false,
        supportedTools: tools,
      }),
    ),
  );
  expect(fixture.native.decide).not.toHaveBeenCalled();
});

it.each(["mcp", "peer"] as const)(
  "observes native %s control and clears it on release or disable",
  async (kind) => {
    vi.useFakeTimers();
    const principal = {
      id: "token",
      label: "Local agent",
      kind,
      ...(kind === "peer"
        ? { generation: "connection-1" }
        : {}),
    };
    let controller: typeof principal | null = null;
    vi.mocked(fixture.native.snapshot).mockImplementation(
      async () => ({ ...snapshot(), controller }),
    );
    const view = mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(view.runtime.ready()).toBe(true);
    await view.runtime.configure(true);
    expect(view.runtime.controller()).toBeNull();
    controller = principal;
    await vi.advanceTimersByTimeAsync(1000);
    expect(view.runtime.controller()).toEqual(principal);
    expect(fixture.setController).toHaveBeenLastCalledWith(
      kind === "peer"
        ? { id: principal.id, generation: "connection-1" }
        : null,
    );
    controller = null;
    await vi.advanceTimersByTimeAsync(1000);
    expect(view.runtime.controller()).toBeNull();
    expect(fixture.setController).toHaveBeenLastCalledWith(
      null,
    );
    controller = principal;
    await view.runtime.configure(false);
    expect(view.runtime.controller()).toBeNull();
    expect(fixture.sessions).toEqual({});
    expect(fixture.setController).toHaveBeenLastCalledWith(
      null,
    );
  },
);
it("preserves call rows and text selection when unchanged native snapshots arrive", async () => {
  let status = "ok";
  vi.mocked(fixture.native.snapshot).mockImplementation(
    async () => ({
      ...snapshot(),
      audit: [
        {
          id: "call-1",
          principal: "Peer",
          at: 1700000000000,
          tool: "control.text",
          target: "local",
          status,
        },
      ],
    }),
  );
  let runtime!: ReturnType<typeof createAutomation>;
  const view = render(() => {
    runtime = createAutomation({} as AppStateContextProps);
    return (
      <For each={runtime.snapshot().audit}>
        {(entry) => (
          <span>
            {entry.tool} · {entry.status}
          </span>
        )}
      </For>
    );
  });
  await waitFor(() => expect(runtime.ready()).toBe(true));
  const row = view.getByText("control.text · ok");
  const selection = document.getSelection()!;
  const range = document.createRange();
  range.selectNodeContents(row);
  selection.removeAllRanges();
  selection.addRange(range);
  await runtime.configure(true);
  expect(view.getByText("control.text · ok")).toBe(row);
  expect(selection.toString()).toBe("control.text · ok");
  status = "PERMISSION_DENIED";
  await runtime.configure(true);
  expect(
    view.getByText("control.text · PERMISSION_DENIED"),
  ).toBe(row);
  selection.removeAllRanges();
});
beforeEach(() => {
  fixture.configureShortcut.mockReset().mockResolvedValue();
  fixture.generation = "connection-1";
  fixture.events = new EventTarget();
  fixture.closeLink = undefined;
  fixture.handle.mockReset().mockResolvedValue({});
  fixture.remoteCall.mockReset().mockResolvedValue({
    ok: true,
    data: { remote: true },
  });
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
    configureMcp: vi.fn(async () => {}),
    peer: vi.fn(async () => {}),
    peerPolicy: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    decide: vi.fn(async () => {}),
    call: vi.fn(async () => ({ ok: true, data: {} })),
    cancel: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    finish: vi.fn(async () => {}),
  } as unknown as NativeAutomation;
  setAppState("options", "automationEnabled", false);
  setAppState("options", "mcpEnabled", false);
  setAppState(
    "options",
    "clientConfigs",
    "peer",
    undefined,
  );
});
it.each([true, false])(
  "forwards session approval %s as a boolean and refreshes authority",
  async (accepted) => {
    const view = mount();
    await waitFor(() =>
      expect(view.runtime.ready()).toBe(true),
    );
    const snapshots = vi.mocked(fixture.native.snapshot)
      .mock.calls.length;
    await view.runtime.decide("request", accepted);
    expect(fixture.native.decide).toHaveBeenCalledWith(
      "epoch",
      "request",
      accepted,
    );
    expect(
      vi.mocked(fixture.native.snapshot).mock.calls.length,
    ).toBeGreaterThan(snapshots);
  },
);
it("uses the saved host emergency shortcut before starting local automation without a room", async () => {
  setAppState(
    "options",
    "remoteKeyboard",
    "emergencyShortcut",
    "ctrl-alt-shift-f9",
  );
  try {
    const view = mount();
    await waitFor(() =>
      expect(view.runtime.ready()).toBe(true),
    );
    await view.runtime.configure(true);
    expect(fixture.configureShortcut).toHaveBeenCalledWith(
      "ctrl-alt-shift-f9",
    );
    expect(
      fixture.configureShortcut.mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(fixture.native.configure).mock
        .invocationCallOrder[0],
    );
  } finally {
    setAppState(
      "options",
      "remoteKeyboard",
      "emergencyShortcut",
      "ctrl-alt-shift-f10",
    );
  }
});

it.each([true, false])(
  "saves a remembered native decision %s only for the requesting permission group",
  async (accepted) => {
    peer();
    setAppState("options", "clientConfigs", "peer", {
      automation: { "shell.execute": "deny" },
    });
    const request = {
      id: "remember",
      principal: {
        id: "peer",
        label: "Peer",
        kind: "peer" as const,
        generation: "connection-1",
      },
      scope: "diagnostics.read" as const,
      tool: "diagnostics.snapshot",
      arguments: { target: "local" },
      expiresAt: Date.now() + 120000,
    };
    vi.mocked(fixture.native.snapshot).mockImplementation(
      async () => ({ ...snapshot(), pending: [request] }),
    );
    const { runtime } = mount();
    await waitFor(() => expect(runtime.ready()).toBe(true));
    await runtime.decide(request.id, accepted, true);
    expect(fixture.native.decide).toHaveBeenCalledWith(
      "epoch",
      request.id,
      accepted,
      true,
    );
    expect(
      appState.options.clientConfigs.peer?.automation,
    ).toEqual({
      "diagnostics.read": accepted ? "allow" : "deny",
      "screen.read": accepted ? "allow" : "deny",
      "accessibility.read": accepted ? "allow" : "deny",
      "shell.execute": "deny",
    });
    expect(
      fixture.native.peerPolicy,
    ).toHaveBeenLastCalledWith(
      "epoch",
      expect.objectContaining({
        id: "peer",
        generation: "connection-1",
      }),
      appState.options.clientConfigs.peer?.automation,
    );
  },
);

it("does not save a native permanent choice after the device reconnects during the answer", async () => {
  peer();
  const request = {
    id: "remember",
    principal: {
      id: "peer",
      label: "Peer",
      kind: "peer" as const,
      generation: "connection-1",
    },
    scope: "diagnostics.read" as const,
    tool: "diagnostics.snapshot",
    arguments: { target: "local" },
    expiresAt: Date.now() + 120000,
  };
  vi.mocked(fixture.native.snapshot).mockImplementation(
    async () => ({ ...snapshot(), pending: [request] }),
  );
  vi.mocked(fixture.native.decide).mockImplementation(
    async () => {
      fixture.generation = "connection-2";
    },
  );
  const { runtime } = mount();
  await waitFor(() => expect(runtime.ready()).toBe(true));
  await expect(
    runtime.decide(request.id, true, true),
  ).rejects.toMatchObject({ code: "TARGET_DISCONNECTED" });
  expect(
    appState.options.clientConfigs.peer?.automation,
  ).toBeUndefined();
});
it("does not reenable automation when shortcut setup finishes after a newer disable", async () => {
  const view = mount();
  await waitFor(() =>
    expect(view.runtime.ready()).toBe(true),
  );
  let release!: () => void;
  fixture.configureShortcut.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const enabling = view.runtime.configure(true);
  await waitFor(() => expect(release).toBeDefined());
  try {
    await view.runtime.configure(false);
  } finally {
    release();
  }
  await enabling;
  expect(fixture.native.configure).toHaveBeenCalledTimes(1);
  expect(fixture.native.configure).toHaveBeenCalledWith(
    "epoch",
    false,
  );
  expect(view.runtime.enabled()).toBe(false);
  expect(appState.options.automationEnabled).toBe(false);
});
it.each([false, true])(
  "orders a newer disable after an in-flight native enable (failed=%s)",
  async (failed) => {
    const view = mount();
    await waitFor(() =>
      expect(view.runtime.ready()).toBe(true),
    );
    let release!: () => void;
    let nativeEnabled = false;
    vi.mocked(fixture.native.configure).mockImplementation(
      async (_, value) => {
        if (value) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
          if (failed)
            throw new Error("listener unavailable");
        }
        nativeEnabled = value;
      },
    );
    const enabling = view.runtime.configure(true);
    await waitFor(() => expect(release).toBeDefined());
    const disabling = view.runtime.configure(false);
    release();
    await Promise.all([enabling, disabling]);
    expect(
      vi.mocked(fixture.native.configure).mock.calls,
    ).toEqual([
      ["epoch", true],
      ["epoch", false],
    ]);
    expect(nativeEnabled).toBe(false);
    expect(view.runtime.enabled()).toBe(false);
    expect(appState.options.automationEnabled).toBe(false);
    expect(view.runtime.error()).toBe("");
  },
);
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
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: "CANCELLED",
          outcome: "unknown",
          retryable: false,
          nextAction: "stop",
        }),
      }),
    ),
  );
});
it.each([false, true])(
  "a delayed snapshot preserves newer calls and late cleanup cannot finish a replacement (reuse=%s)",
  async (reuse) => {
    const synchronize = vi.spyOn(
      AutomationScreenShares.prototype,
      "synchronize",
    );
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
      resolveSnapshot({
        ...snapshot(),
        activeCalls: [],
        screenGrants: [],
      });
      await waitFor(() =>
        expect(signals.get("old")!.aborted).toBe(true),
      );
      expect(signals.get("new")!.aborted).toBe(false);
      expect(synchronize).not.toHaveBeenCalled();
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
          expect.objectContaining({
            ok: false,
            error: expect.objectContaining({
              code: "CANCELLED",
              outcome: "unknown",
              retryable: false,
              nextAction: "stop",
            }),
          }),
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
it("uses native screen authority across separate permissions and reconciles ownership after tool completion", async () => {
  const synchronize = vi.spyOn(
    AutomationScreenShares.prototype,
    "synchronize",
  );
  const view = mount();
  await waitFor(() =>
    expect(view.runtime.ready()).toBe(true),
  );
  const authority = {
    grantId: "input",
    screenGrantId: "screen",
    screenGrantIds: ["screen"],
  };
  vi.mocked(fixture.native.snapshot).mockResolvedValue({
    ...snapshot(),
    screenGrants: ["screen"],
    controlLeaseId: "lease",
  });
  const receive = vi.mocked(fixture.native.open).mock
    .calls[0][0];
  receive({
    kind: "call",
    id: "acquire",
    ...authority,
    principal: { id: "token", kind: "mcp", label: "Agent" },
    call: {
      name: "control.acquire",
      arguments: { target: "local", trackId: "track" },
    },
  });
  await waitFor(() =>
    expect(fixture.native.finish).toHaveBeenCalled(),
  );
  expect(fixture.handle).toHaveBeenCalledWith(
    expect.anything(),
    expect.any(AbortSignal),
    expect.any(Function),
    expect.any(Function),
    { ...authority, requesterId: "token" },
  );
  await waitFor(() =>
    expect(synchronize).toHaveBeenCalledWith(["screen"]),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
  setAppState("options", "mcpEnabled", true);
  vi.mocked(
    fixture.native.configureMcp,
  ).mockRejectedValueOnce(new Error("PORT_IN_USE"));
  const { runtime } = mount();
  await waitFor(() => expect(runtime.ready()).toBe(true));
  expect(runtime.mcpEnabled()).toBe(false);
  expect(runtime.error()).toContain("PORT_IN_USE");
  expect(runtime.configuredMcpEnabled()).toBe(true);
  expect(appState.options.mcpEnabled).toBe(true);
  expect(fixture.advertise).not.toHaveBeenCalledWith(true);
  await runtime.configureMcp(false);
  expect(runtime.configuredMcpEnabled()).toBe(false);
  expect(appState.options.mcpEnabled).toBe(false);
});
it("does not start the listener if the owner closes while native initialization is pending", async () => {
  setAppState("options", "mcpEnabled", true);
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
  expect(
    fixture.native.configureMcp,
  ).not.toHaveBeenCalled();
  expect(appState.options.mcpEnabled).toBe(true);
});
function peer() {
  fixture.sessions.peer = {
    clientId: "a",
    targetClientId: "peer",
    isMessageChannelReady: true,
    peerConnection: {},
    addEventListener: fixture.events.addEventListener.bind(
      fixture.events,
    ),
    createChannel: async (
      _label: string,
      _protocol: string,
      onAvailable?: (channel: unknown) => void,
    ) => {
      const channel = { close() {} };
      onAvailable?.(channel);
      return channel;
    },
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
it("keeps the peer session and calls alive while Weblink is hidden and status refresh is delayed", async () => {
  peer();
  const view = mount();
  await waitFor(() =>
    expect(view.runtime.ready()).toBe(true),
  );
  await view.runtime.configure(true);
  await waitFor(() =>
    expect(fixture.incoming).toBeDefined(),
  );
  await incoming();
  const connection = fixture.incoming;
  let finish!: () => void;
  let active!: AbortSignal;
  fixture.handle.mockImplementationOnce(
    async (_, signal) => {
      active = signal;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      signal.throwIfAborted();
      return { completed: true };
    },
  );
  const receive = vi.mocked(fixture.native.open).mock
    .calls[0][0];
  receive({
    kind: "call",
    id: "background",
    principal: { id: "token", label: "Agent", kind: "mcp" },
    call: {
      name: "screen.start",
      arguments: { target: "local", sourceId: "screen" },
    },
  });
  await waitFor(() => expect(active).toBeDefined());
  try {
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(
      true,
    );
    vi.spyOn(
      document,
      "visibilityState",
      "get",
    ).mockReturnValue("hidden");
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("visibilitychange"));
    // Advance the wall clock without running renderer timers, as in a throttled page.
    vi.setSystemTime(Date.now() + 60_000);
    expect(view.runtime.enabled()).toBe(true);
    expect(active.aborted).toBe(false);
    expect(fixture.incoming).toBe(connection);
    expect(fixture.native.close).not.toHaveBeenCalled();
    expect(
      fixture.native.disconnect,
    ).not.toHaveBeenCalled();
    expect(fixture.native.cancel).not.toHaveBeenCalled();
    await incoming();
    expect(fixture.native.call).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
    finish();
  }
  await waitFor(() =>
    expect(fixture.native.finish).toHaveBeenCalledWith(
      "epoch",
      "background",
      { ok: true, data: { completed: true } },
    ),
  );
  view.unmount();
  await waitFor(() =>
    expect(fixture.native.close).toHaveBeenCalledWith(
      "epoch",
    ),
  );
});
it.each([true, false])(
  "forwards token calls without local consent and preserves the destination decision (allowed=%s)",
  async (allowed) => {
    peer();
    const result: ToolResult = allowed
      ? { ok: true, data: { remote: true } }
      : {
          ok: false,
          error: {
            code: "PERMISSION_DENIED",
            message: "PERMISSION_DENIED",
          },
        };
    fixture.remoteCall.mockResolvedValue(result);
    const view = mount();
    await waitFor(() =>
      expect(view.runtime.ready()).toBe(true),
    );
    await view.runtime.configureMcp(true);
    expect(view.runtime.enabled()).toBe(false);
    await waitFor(() =>
      expect(fixture.incoming).toBeDefined(),
    );
    const source = {
      kind: "mcp" as const,
      label: "Local agent",
    };
    vi.mocked(fixture.native.open).mock.calls[0][0]({
      kind: "call",
      id: "forwarded",
      principal: {
        id: "token",
        label: "Local agent",
        kind: "mcp",
      },
      call: {
        source,
        name: "diagnostics.snapshot",
        arguments: { target: "peer" },
      },
    });
    await waitFor(() =>
      expect(fixture.native.finish).toHaveBeenCalledWith(
        "epoch",
        "forwarded",
        allowed
          ? result
          : expect.objectContaining({
              ok: false,
              error: expect.objectContaining({
                code: "PERMISSION_DENIED",
                outcome: "not_applied",
                retryable: false,
                nextAction: "request_permission",
              }),
            }),
      ),
    );
    expect(fixture.native.check).toHaveBeenCalledWith(
      "epoch",
      "forwarded",
    );
    expect(fixture.remoteCall).toHaveBeenCalledWith(
      {
        source,
        name: "diagnostics.snapshot",
        arguments: { target: "local" },
      },
      expect.any(AbortSignal),
    );
    expect(fixture.handle).not.toHaveBeenCalled();
  },
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
    expect.objectContaining({
      id: "peer",
      generation: "connection-1",
    }),
    { "diagnostics.read": "allow" },
  );
  expect(fixture.native.peer).toHaveBeenCalledWith(
    "epoch",
    expect.objectContaining({
      id: "peer",
      generation: "connection-1",
    }),
    "Peer",
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
    ).toHaveBeenLastCalledWith(
      "epoch",
      expect.objectContaining({
        id: "peer",
        generation: "connection-1",
      }),
      {
        "diagnostics.read": "deny",
      },
    ),
  );
  view.unmount();
  await waitFor(() =>
    expect(fixture.native.disconnect).toHaveBeenCalledWith(
      "epoch",
      expect.objectContaining({
        id: "peer",
        generation: "connection-1",
      }),
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
it.each(["session", "generation"])(
  "rejects a stale channel when its %s changes during native registration",
  async (change) => {
    peer();
    let resolve!: () => void;
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
    if (change === "session") peer();
    else fixture.generation = "connection-2";
    resolve();
    await rejected;
    expect(
      fixture.native.peerPolicy,
    ).not.toHaveBeenCalled();
    expect(fixture.native.call).not.toHaveBeenCalled();
    expect(fixture.native.disconnect).toHaveBeenCalledWith(
      "epoch",
      expect.objectContaining({
        id: "peer",
        generation: "connection-1",
      }),
    );
  },
);

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
  ).toHaveBeenLastCalledWith(
    "epoch",
    expect.objectContaining({
      id: "peer",
      generation: "connection-1",
    }),
    {
      "diagnostics.read": "deny",
    },
  );
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

it("waits for native cleanup before reopening an automation channel in the same connection generation", async () => {
  peer();
  const view = mount();
  await waitFor(() =>
    expect(view.runtime.ready()).toBe(true),
  );
  await view.runtime.configure(true);
  await waitFor(() =>
    expect(fixture.incoming).toBeDefined(),
  );
  await incoming();
  const previous = fixture.incoming;
  let release!: () => void;
  vi.mocked(
    fixture.native.disconnect,
  ).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  fixture.closeLink!();
  await waitFor(() => expect(release).toBeDefined());
  fixture.events.dispatchEvent(
    new CustomEvent("messagechannelchange", {
      detail: "ready",
    }),
  );
  expect(view.runtime.peers()).toEqual([]);
  expect(fixture.incoming).toBe(previous);
  expect(fixture.native.peer).toHaveBeenCalledTimes(1);
  release();
  await waitFor(() =>
    expect(fixture.incoming).not.toBe(previous),
  );
  await incoming();
  expect(fixture.native.peer).toHaveBeenCalledTimes(2);
  expect(fixture.native.disconnect).toHaveBeenCalledTimes(
    1,
  );
  expect(
    vi.mocked(fixture.native.peer).mock.calls[1][1],
  ).toMatchObject({
    id: "peer",
    generation: "connection-1",
  });
});

it("fences a registered channel immediately when the shared connection generation changes", async () => {
  peer();
  const view = mount();
  await waitFor(() =>
    expect(view.runtime.ready()).toBe(true),
  );
  await view.runtime.configure(true);
  await waitFor(() =>
    expect(fixture.incoming).toBeDefined(),
  );
  await incoming();
  const previous = fixture.incoming;
  fixture.generation = "connection-2";
  await expect(incoming()).rejects.toThrow(
    "TARGET_DISCONNECTED",
  );
  expect(fixture.native.call).toHaveBeenCalledTimes(1);
  fixture.events.dispatchEvent(
    new CustomEvent("messagechannelchange", {
      detail: "ready",
    }),
  );
  await waitFor(() =>
    expect(fixture.incoming).not.toBe(previous),
  );
  await incoming();
  expect(
    vi.mocked(fixture.native.call).mock.calls[1][1],
  ).toEqual({ id: "peer", generation: "connection-2" });
  expect(fixture.native.disconnect).toHaveBeenCalledWith(
    "epoch",
    expect.objectContaining({
      id: "peer",
      generation: "connection-1",
    }),
  );
});

it("admits automation only after shared paired-device access succeeds and revokes it when access is lost", async () => {
  peer();
  fixture.receive = false;
  const view = mount();
  await waitFor(() =>
    expect(view.runtime.ready()).toBe(true),
  );
  await view.runtime.configure(true);
  expect(fixture.incoming).toBeUndefined();
  expect(fixture.native.peer).not.toHaveBeenCalled();
  fixture.receive = true;
  fixture.events.dispatchEvent(
    new CustomEvent("messagechannelchange", {
      detail: "ready",
    }),
  );
  await waitFor(() =>
    expect(fixture.incoming).toBeDefined(),
  );
  await incoming();
  fixture.receive = false;
  fixture.events.dispatchEvent(
    new CustomEvent("messagechannelchange", {
      detail: "ready",
    }),
  );
  await waitFor(() =>
    expect(fixture.native.disconnect).toHaveBeenCalled(),
  );
  expect(view.runtime.peers()).toEqual([]);
  expect(await incoming()).toMatchObject({
    ok: false,
    error: { code: "PERMISSION_DENIED" },
  });
  expect(fixture.native.call).toHaveBeenCalledTimes(1);
});

it("keeps diagnostics available when both automation and MCP switches are off", async () => {
  peer();
  const { runtime } = mount();
  await waitFor(() => expect(runtime.ready()).toBe(true));
  await runtime.configure(true);
  expect(
    fixture.native.configureMcp,
  ).not.toHaveBeenCalled();
  await waitFor(() =>
    expect(fixture.incoming).toBeDefined(),
  );
  await incoming();
  const connection = fixture.incoming;
  await runtime.configureMcp(true);
  await runtime.configureMcp(false);
  expect(fixture.incoming).toBe(connection);
  expect(runtime.enabled()).toBe(true);
  expect((await incoming()).ok).toBe(true);
  await runtime.configureMcp(true);
  await runtime.configure(false);
  expect(fixture.incoming).toBe(connection);
  expect(runtime.mcpEnabled()).toBe(true);
  expect(runtime.peers()).toHaveLength(1);
  expect(await incoming()).toMatchObject({
    ok: true,
  });
  expect(fixture.native.call).toHaveBeenCalledTimes(3);
  expect(fixture.native.disconnect).not.toHaveBeenCalled();
  await runtime.configure(true);
  expect((await incoming()).ok).toBe(true);
  expect(fixture.native.peer).toHaveBeenCalledTimes(1);
  await runtime.configure(false);
  await runtime.configureMcp(false);
  expect(runtime.peers()).toHaveLength(1);
  expect((await incoming()).ok).toBe(true);
  expect(
    await fixture.incoming!(
      {
        name: "screen.sources",
        arguments: { target: "local" },
      },
      new AbortController().signal,
    ),
  ).toMatchObject({
    ok: false,
    error: { code: "DISABLED" },
  });
  expect(appState.options.automationEnabled).toBe(false);
  expect(appState.options.mcpEnabled).toBe(false);
});

it("a later automation disable supersedes delayed setup without discarding MCP enable", async () => {
  const { runtime } = mount();
  await waitFor(() => expect(runtime.ready()).toBe(true));
  let release!: () => void;
  fixture.configureShortcut.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const enabling = runtime.configure(true);
  await waitFor(() => expect(release).toBeDefined());
  await runtime.configureMcp(true);
  await runtime.configure(false);
  release();
  await enabling;
  expect(runtime.enabled()).toBe(false);
  expect(runtime.mcpEnabled()).toBe(true);
  expect(
    vi.mocked(fixture.native.configure).mock.calls,
  ).toEqual([["epoch", false]]);
  expect(
    vi.mocked(fixture.native.configureMcp).mock.calls,
  ).toEqual([["epoch", true]]);
  expect(appState.options.automationEnabled).toBe(false);
  expect(appState.options.mcpEnabled).toBe(true);
});

it.each([
  [false, true],
  [true, false],
  [true, true],
])(
  "restores automation=%s and MCP=%s independently",
  async (automationEnabled, mcpEnabled) => {
    setAppState("options", {
      automationEnabled,
      mcpEnabled,
    });
    const { runtime } = mount();
    await waitFor(() => expect(runtime.ready()).toBe(true));
    expect(runtime.enabled()).toBe(automationEnabled);
    expect(runtime.mcpEnabled()).toBe(mcpEnabled);
    expect(fixture.native.configure).toHaveBeenCalledTimes(
      Number(automationEnabled),
    );
    expect(
      fixture.native.configureMcp,
    ).toHaveBeenCalledTimes(Number(mcpEnabled));
  },
);
