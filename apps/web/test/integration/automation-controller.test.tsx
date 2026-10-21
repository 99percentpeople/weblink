// @vitest-environment jsdom
import {
  cleanup,
  render,
  waitFor,
} from "@solidjs/testing-library";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { webcrypto } from "node:crypto";
import { createSignal } from "solid-js";
import { createAutomation } from "@/libs/state/create-automation";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import type { registerWebMcp } from "@weblink/automation/webmcp";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import type {
  ToolCall,
  ToolResult,
} from "@weblink/automation";
import type { PeerCapabilities } from "@/libs/domain/protocol/capabilities";
const fixture = vi.hoisted(() => ({
  generation: "connection-1",
  remoteCapabilities: (() => undefined) as () =>
    | PeerCapabilities
    | undefined,
  channel: { close: vi.fn() },
  createChannel: vi.fn<() => Promise<unknown>>(),
  channelReady: true,
  finishOpening: undefined as (() => void) | undefined,
  closeLink: undefined as (() => void) | undefined,
  events: undefined as unknown as EventTarget,
  messageReady: true,
  pc: {},
  advertise: vi.fn(),
  call: vi.fn(
    async (
      _call: ToolCall,
      _signal: AbortSignal,
    ): Promise<ToolResult> => ({
      ok: true,
      data: { desktop: true },
    }),
  ),
  incoming: undefined as
    | undefined
    | ((
        call: ToolCall,
        signal: AbortSignal,
      ) => Promise<ToolResult>),
}));
vi.mock("@/libs/platform/runtime", () => ({
  platform: { kind: "web" },
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {
    sessions: {
      desktop: {
        clientId: "a",
        targetClientId: "desktop",
        get isMessageChannelReady() {
          return fixture.messageReady;
        },
        get peerConnection() {
          return fixture.pc;
        },
        addEventListener(
          ...args: Parameters<
            EventTarget["addEventListener"]
          >
        ) {
          fixture.events.addEventListener(...args);
        },
        createChannel: async (
          _label: string,
          _protocol: string,
          onAvailable?: (channel: unknown) => void,
        ) => {
          const channel = await fixture.createChannel();
          onAvailable?.(channel);
          return channel;
        },
      },
    },
    clientViewData: { desktop: { name: "Desktop" } },
    capabilities: {
      generation: () => fixture.generation,
      get: () => fixture.remoteCapabilities(),
    },
    setAutomationEnabled: fixture.advertise,
    canReceive: () => true,
    canShareScreen: () => true,
  },
}));
vi.mock("@/libs/application/automation/handlers", () => ({
  automationHandlers: () => async () => ({ local: true }),
  diagnosticSources: () => [],
}));
vi.mock("@/libs/application/automation/peer-link", () => ({
  AUTOMATION_CHANNEL: "weblink-automation/1",
  AutomationPeerLink: class {
    readonly lifetime = new AbortController();
    readonly ready: Promise<void>;
    connected = false;
    failure?: string;
    constructor(
      _channel: unknown,
      invoke: typeof fixture.incoming,
      changed: () => void,
      private disconnected: () => void,
    ) {
      fixture.incoming = invoke;
      fixture.closeLink = () => this.close();
      this.ready = new Promise((resolve) => {
        const finish = () => {
          this.connected = true;
          resolve();
          changed();
        };
        if (fixture.channelReady) finish();
        else fixture.finishOpening = finish;
      });
    }
    call = fixture.call;
    close() {
      if (this.lifetime.signal.aborted) return;
      if (!this.connected) this.failure = "OPEN_TIMEOUT";
      this.lifetime.abort();
      this.disconnected();
    }
  },
}));
type ModelContext = Parameters<typeof registerWebMcp>[0];
const setContext = (value: unknown) =>
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value,
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
  fixture.generation = "connection-1";
  vi.stubGlobal("crypto", webcrypto);
  setAppState("options", "automationEnabled", false);
  fixture.incoming = undefined;
  fixture.channelReady = true;
  fixture.finishOpening = undefined;
  fixture.closeLink = undefined;
  fixture.events = new EventTarget();
  fixture.messageReady = true;
  fixture.pc = {};
  vi.clearAllMocks();
  fixture.remoteCapabilities = () => ({
    automation: {},
    identity: { receiveContent: true },
  });
  fixture.createChannel
    .mockReset()
    .mockResolvedValue(fixture.channel);
});
afterEach(() => {
  cleanup();
  delete (document as Document & { modelContext?: unknown })
    .modelContext;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it.each([undefined, false])(
  "waits for the destination to allow receiving before opening automation (receive=%s)",
  async (receiveContent) => {
    const [capabilities, setCapabilities] =
      createSignal<PeerCapabilities>({
        automation: {},
        ...(receiveContent === undefined
          ? {}
          : {
              identity: { receiveContent },
            }),
      });
    fixture.remoteCapabilities = capabilities;
    setContext({ registerTool: vi.fn(async () => {}) });
    vi.useFakeTimers();
    const { runtime } = mount();
    await runtime.configure(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fixture.createChannel).not.toHaveBeenCalled();
    expect(runtime.peers()).toEqual([]);

    setCapabilities({
      automation: {},
      identity: { receiveContent: true },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.createChannel).toHaveBeenCalledTimes(1);
    expect(runtime.peers()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fixture.createChannel).toHaveBeenCalledTimes(1);

    setCapabilities({
      automation: {},
      identity: { receiveContent: false },
    });
    expect(runtime.peers()).toEqual([]);
    await vi.advanceTimersByTimeAsync(3000);
    expect(fixture.createChannel).toHaveBeenCalledTimes(1);
    setCapabilities({
      automation: {},
      identity: { receiveContent: true },
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.createChannel).toHaveBeenCalledTimes(2);
    expect(runtime.peers()).toHaveLength(1);
  },
);
it("closes a pending automation channel when destination consent is withdrawn before it opens", async () => {
  const [capabilities, setCapabilities] =
    createSignal<PeerCapabilities>({
      automation: {},
      identity: { receiveContent: true },
    });
  fixture.remoteCapabilities = capabilities;
  setContext({ registerTool: vi.fn(async () => {}) });
  let opened!: (channel: unknown) => void;
  fixture.createChannel.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        opened = resolve;
      }),
  );
  const { runtime } = mount();
  await runtime.configure(true);
  expect(opened).toBeDefined();
  setCapabilities({
    automation: {},
    identity: { receiveContent: false },
  });
  opened(fixture.channel);
  await waitFor(() =>
    expect(fixture.channel.close).toHaveBeenCalledOnce(),
  );
  expect(runtime.peers()).toEqual([]);
  expect(fixture.incoming).toBeUndefined();
});
it("lists a device only after the automation channel opens", async () => {
  fixture.channelReady = false;
  setContext({ registerTool: vi.fn(async () => {}) });
  const { runtime } = mount();
  await runtime.configure(true);
  await waitFor(() =>
    expect(fixture.finishOpening).toBeDefined(),
  );
  expect(runtime.peers()).toEqual([]);
  fixture.finishOpening!();
  expect(runtime.peers()).toHaveLength(1);
});
it("uses channel readiness events instead of scanning sessions on a timer and removes listeners on cleanup", async () => {
  vi.useFakeTimers();
  fixture.messageReady = false;
  setContext({ registerTool: vi.fn(async () => {}) });
  const { runtime, unmount } = mount();
  await runtime.configure(true);
  fixture.messageReady = true;
  await vi.advanceTimersByTimeAsync(5000);
  expect(fixture.createChannel).not.toHaveBeenCalled();
  fixture.events.dispatchEvent(
    new CustomEvent("messagechannelchange", {
      detail: "ready",
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.createChannel).toHaveBeenCalledTimes(1);
  expect(runtime.peers()).toHaveLength(1);

  fixture.messageReady = false;
  fixture.events.dispatchEvent(
    new CustomEvent("messagechannelchange", {
      detail: "closed",
    }),
  );
  expect(runtime.peers()).toEqual([]);
  fixture.messageReady = true;
  fixture.events.dispatchEvent(
    new CustomEvent("messagechannelchange", {
      detail: "ready",
    }),
  );
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.createChannel).toHaveBeenCalledTimes(2);
  expect(runtime.peers()).toHaveLength(1);
  unmount();
  fixture.events.dispatchEvent(
    new CustomEvent("messagechannelchange", {
      detail: "ready",
    }),
  );
  fixture.events.dispatchEvent(
    new CustomEvent("peerconnectioninit", {
      detail: fixture.pc,
    }),
  );
  await vi.advanceTimersByTimeAsync(5000);
  expect(fixture.createChannel).toHaveBeenCalledTimes(2);
});
it("starts a replacement from its connection event and ignores an older channel that opens late", async () => {
  setContext({ registerTool: vi.fn(async () => {}) });
  let oldOpened!: (channel: unknown) => void;
  let newOpened!: (channel: unknown) => void;
  fixture.createChannel
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          oldOpened = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          newOpened = resolve;
        }),
    );
  const { runtime } = mount();
  await runtime.configure(true);
  expect(fixture.createChannel).toHaveBeenCalledTimes(1);
  fixture.pc = {};
  fixture.events.dispatchEvent(
    new CustomEvent("peerconnectioninit", {
      detail: fixture.pc,
    }),
  );
  expect(fixture.createChannel).toHaveBeenCalledTimes(2);
  const oldChannel = { close: vi.fn() };
  oldOpened(oldChannel);
  await waitFor(() =>
    expect(oldChannel.close).toHaveBeenCalledOnce(),
  );
  expect(runtime.peers()).toEqual([]);
  fixture.events.dispatchEvent(
    new CustomEvent("messagechannelchange", {
      detail: "ready",
    }),
  );
  expect(fixture.createChannel).toHaveBeenCalledTimes(2);
  newOpened(fixture.channel);
  await waitFor(() =>
    expect(runtime.peers()).toHaveLength(1),
  );
  expect(fixture.channel.close).not.toHaveBeenCalled();
});
it("recovers an established channel from its close event without retrying failed channel opens", async () => {
  vi.useFakeTimers();
  setContext({ registerTool: vi.fn(async () => {}) });
  const { runtime } = mount();
  await runtime.configure(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(runtime.peers()).toHaveLength(1);
  fixture.channelReady = false;
  fixture.closeLink!();
  await vi.advanceTimersByTimeAsync(0);
  expect(fixture.createChannel).toHaveBeenCalledTimes(2);
  expect(runtime.peers()).toEqual([]);
  fixture.closeLink!();
  await vi.advanceTimersByTimeAsync(10000);
  expect(fixture.createChannel).toHaveBeenCalledTimes(2);
  expect(runtime.peers()).toEqual([]);
});
it("WebMCP routes directly to the desktop and rejects incoming automation without local approvals", async () => {
  const tools = new Map<
    string,
    {
      execute(
        input: Record<string, unknown>,
      ): Promise<ToolResult>;
    }
  >();
  setContext({
    async registerTool(tool, { signal }) {
      tools.set(tool.name, tool);
      signal.addEventListener(
        "abort",
        () => tools.delete(tool.name),
        { once: true },
      );
    },
  } satisfies ModelContext);
  const { runtime } = mount();
  await runtime.configure(true);
  await waitFor(() =>
    expect(fixture.incoming).toBeDefined(),
  );
  const result = await tools
    .get("diagnostics.snapshot")!
    .execute({ target: "desktop" });
  expect(result).toEqual({
    ok: true,
    data: { desktop: true },
  });
  expect(fixture.call).toHaveBeenCalledWith(
    expect.objectContaining({
      arguments: { target: "local" },
    }),
    expect.any(AbortSignal),
  );
  expect(runtime.snapshot().pending).toEqual([]);
  const incoming = await fixture.incoming!(
    {
      name: "diagnostics.snapshot",
      arguments: { target: "local" },
    },
    new AbortController().signal,
  );
  expect(incoming).toMatchObject({
    ok: false,
    error: { code: "UNSUPPORTED" },
  });
  await runtime.configure(false);
  expect(tools.size).toBe(0);
});
it.each([undefined, null, {}, { registerTool: true }])(
  "rejects unavailable WebMCP without advertising automation: %j",
  async (context) => {
    setContext(context);
    const { runtime } = mount();
    await waitFor(() => expect(runtime.ready()).toBe(true));
    expect(runtime.webSupported()).toBe(false);
    await expect(
      runtime.configure(true),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED",
    });
    expect(runtime.enabled()).toBe(false);
    expect(appState.options.automationEnabled).toBe(false);
    expect(fixture.advertise).not.toHaveBeenCalledWith(
      true,
    );
    expect(fixture.incoming).toBeUndefined();
  },
);
it("does not restore enabled state in an unsupported browser or erase the saved preference", async () => {
  setAppState("options", "automationEnabled", true);
  const { runtime } = mount();
  await waitFor(() => expect(runtime.ready()).toBe(true));
  expect(runtime.enabled()).toBe(false);
  expect(runtime.error()).toBe("");
  expect(appState.options.automationEnabled).toBe(true);
  expect(fixture.advertise).not.toHaveBeenCalledWith(true);
});
it("keeps automation disabled when asynchronous tool registration fails", async () => {
  setContext({
    registerTool: vi.fn(async () => {
      throw new Error("Registration denied");
    }),
  } satisfies ModelContext);
  const { runtime } = mount();
  await expect(runtime.configure(true)).rejects.toThrow(
    "Registration denied",
  );
  expect(runtime.enabled()).toBe(false);
  expect(runtime.error()).toContain("Registration denied");
  expect(appState.options.automationEnabled).toBe(false);
  expect(fixture.advertise).not.toHaveBeenCalledWith(true);
});
it.each(["disable", "unmount"])(
  "cancels pending WebMCP registration on %s",
  async (action) => {
    let finish!: () => void;
    let registration!: AbortSignal;
    const register = vi.fn<ModelContext["registerTool"]>(
      async (_, { signal }) => {
        registration = signal;
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
    );
    setContext({ registerTool: register });
    const { runtime, unmount } = mount();
    const enabling = runtime.configure(true);
    expect(runtime.enabled()).toBe(false);
    if (action === "unmount") unmount();
    else await runtime.configure(false);
    expect(registration.aborted).toBe(true);
    finish();
    await enabling;
    expect(register).toHaveBeenCalledTimes(1);
    expect(runtime.enabled()).toBe(false);
    expect(appState.options.automationEnabled).toBe(false);
    expect(fixture.advertise).not.toHaveBeenCalledWith(
      true,
    );
  },
);
