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
import { createAutomation } from "@/libs/state/create-automation";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import type { registerWebMcp } from "@weblink/automation/webmcp";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import { AutomationPermissions } from "@/libs/application/automation/permissions";
import type {
  ToolCall,
  ToolResult,
} from "@weblink/automation";
const fixture = vi.hoisted(() => ({
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
        isMessageChannelReady: true,
        peerConnection: {},
        addEventListener() {},
        createChannel: async () => ({}),
      },
    },
    clientViewData: { desktop: { name: "Desktop" } },
    capabilities: { get: () => ({ automation: 1 }) },
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
  AutomationPeerLink: class {
    readonly lifetime = new AbortController();
    readonly ready = Promise.resolve();
    readonly fingerprint = "a".repeat(64);
    constructor(
      _channel: unknown,
      invoke: typeof fixture.incoming,
    ) {
      fixture.incoming = invoke;
    }
    call = fixture.call;
    close() {
      this.lifetime.abort();
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
  vi.stubGlobal("crypto", webcrypto);
  setAppState("options", "automationEnabled", false);
  fixture.incoming = undefined;
  vi.clearAllMocks();
});
afterEach(() => {
  cleanup();
  delete (document as Document & { modelContext?: unknown })
    .modelContext;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
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
  const require = vi.spyOn(
    AutomationPermissions.prototype,
    "require",
  );
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
  expect(require).not.toHaveBeenCalled();
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
