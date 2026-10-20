// @vitest-environment jsdom
import {
  cleanup,
  render,
  waitFor,
} from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { createAutomation } from "@/libs/state/create-automation";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import { AutomationPermissions } from "@/libs/application/automation/permissions";
import type {
  ToolCall,
  ToolResult,
} from "@weblink/automation";
const fixture = vi.hoisted(() => ({
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
    setAutomationEnabled() {},
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it("WebMCP routes directly to the desktop and rejects incoming automation without local approvals", async () => {
  vi.stubGlobal("crypto", webcrypto);
  const tools = new Map<
    string,
    {
      execute(
        input: Record<string, unknown>,
      ): Promise<ToolResult>;
    }
  >();
  Object.defineProperty(document, "modelContext", {
    configurable: true,
    value: {
      registerTool: (tool: {
        name: string;
        execute(
          input: Record<string, unknown>,
        ): Promise<ToolResult>;
      }) => tools.set(tool.name, tool),
      unregisterTool: (name: string) => tools.delete(name),
    },
  });
  const require = vi.spyOn(
    AutomationPermissions.prototype,
    "require",
  );
  let runtime!: ReturnType<typeof createAutomation>;
  render(() => {
    runtime = createAutomation({} as AppStateContextProps);
    return null;
  });
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
  delete (document as Document & { modelContext?: unknown })
    .modelContext;
});
