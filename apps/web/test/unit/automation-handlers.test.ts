import { afterEach, expect, it, vi } from "vitest";
import {
  automationHandlers,
  diagnosticSources,
} from "@/libs/application/automation/handlers";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import type { PlatformRuntime } from "@weblink/platform";
import type { AutomationDiagnostics } from "@/libs/application/automation/diagnostics";
import { PresentationDiagnostics } from "@/libs/application/automation/presentation";
import { parseCall, validate } from "@weblink/automation";
import {
  getDefaultAppOptions,
  type AppOption,
} from "@/libs/state/app-options";
const fixture = vi.hoisted(() => ({
  capture: vi.fn(),
  sessions: {} as Record<string, unknown>,
  views: {} as Record<string, unknown>,
  options: {} as AppOption,
  capabilities: {} as Record<
    string,
    import("@/libs/domain/protocol/capabilities").PeerCapabilities
  >,
  setState: vi.fn(),
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {
    get sessions() {
      return fixture.sessions;
    },
    get clientViewData() {
      return fixture.views;
    },
    capabilities: {
      get: (session: { targetClientId: string }) =>
        fixture.capabilities[session.targetClientId],
    },
  },
}));
vi.mock("@/libs/application/native-screen-service", () => ({
  createNativeScreenStream: fixture.capture,
  getNativeScreenPublication: () => undefined,
  getNativeCaptureStatus: () => undefined,
}));
vi.mock(
  "@/libs/application/meeting-video-settings",
  () => ({ nativeScreenOptions: () => ({}) }),
);
vi.mock("@/libs/state/app-state", () => ({
  appState: {
    get options() {
      return fixture.options;
    },
  },
  setAppState: fixture.setState,
}));
afterEach(() => {
  vi.resetAllMocks();
  fixture.sessions = {};
  fixture.views = {};
  fixture.capabilities = {};
  fixture.options = {} as AppOption;
});
it("discovers runtime and real automation transport without invoking or granting remote tools", async () => {
  fixture.sessions = {
    browser: {
      targetClientId: "browser",
      peerConnection: { connectionState: "connected" },
    },
    legacy: {
      targetClientId: "legacy",
      peerConnection: { connectionState: "connected" },
    },
  };
  fixture.capabilities = {
    browser: {
      automation: {
        diagnostics: true,
        runtime: "browser",
        os: "browser",
        appVersion: "1.2.3",
        automationEnabled: false,
        supportedTools: ["diagnostics.snapshot"],
      },
    },
    legacy: { automation: {} },
  };
  const native = vi.fn();
  const run = automationHandlers(
    {} as AppStateContextProps,
    { kind: "desktop" } as PlatformRuntime,
    {} as AutomationDiagnostics,
    {
      local: () => ({
        runtime: "desktop",
        os: "windows",
        appVersion: "1.2.3",
        automationEnabled: false,
        supportedTools: ["commands.run"],
      }),
      connection: (id) =>
        id === "browser" ? "connected" : "connecting",
    },
  );
  const result = await run(
    {
      name: "devices.list",
      arguments: { target: "local" },
    },
    new AbortController().signal,
    native,
  );
  expect(result).toMatchObject({
    devices: [
      {
        id: "local",
        runtime: "desktop",
        automationEnabled: false,
        supportedTools: ["commands.run"],
        disabledReason: "automation_disabled",
        automationConnection: "local",
        permissionsVerified: false,
      },
      {
        id: "browser",
        automation: true,
        connection: "connected",
        runtime: "browser",
        disabledReason: "browser_runtime",
        automationConnection: "connected",
        permissionsVerified: false,
      },
      {
        id: "legacy",
        automation: true,
        connection: "connected",
        runtime: null,
        supportedTools: null,
        automationConnection: "connecting",
        disabledReason: "capabilities_unavailable",
        permissionsVerified: false,
      },
    ],
  });
  expect(native).not.toHaveBeenCalled();
  expect(fixture.setState).not.toHaveBeenCalled();
});

it("routes saved video preferences through the app store without native action or capture", async () => {
  fixture.options = getDefaultAppOptions();
  fixture.setState.mockImplementation((_key, patch) => {
    Object.assign(fixture.options, patch);
  });
  const run = automationHandlers(
    {} as AppStateContextProps,
    {
      kind: "desktop",
      screenShare: { encoders: async () => [] },
      capture: {
        backends: async () => ({ screen: [], window: [] }),
      },
    } as unknown as PlatformRuntime,
    {} as AutomationDiagnostics,
  );
  const native = vi.fn();
  const signal = new AbortController().signal;
  const result = await run(
    {
      name: "screen.settings.update",
      arguments: {
        target: "local",
        patch: { readbackBuffers: 1 },
      },
    },
    signal,
    native,
  );
  expect(result).toMatchObject({
    updated: true,
    settings: { readbackBuffers: 1 },
  });
  expect(fixture.setState).toHaveBeenCalledExactlyOnceWith(
    "options",
    { nativeReadbackBuffers: 1 },
  );
  expect(
    await run(
      {
        name: "screen.settings.get",
        arguments: { target: "local" },
      },
      signal,
      native,
    ),
  ).toMatchObject({ settings: { readbackBuffers: 1 } });
  expect(native).not.toHaveBeenCalled();
  expect(fixture.capture).not.toHaveBeenCalled();
});
it("exports receiver error codes without native error strings or file paths", async () => {
  fixture.sessions = { peer: { targetClientId: "peer" } };
  fixture.views = {
    peer: {
      nativeScreenViews: [
        {
          sourceId: "screen",
          error:
            "Decode failed 0x80004005 at C:\\private\\secret.txt",
          stream: null,
        },
      ],
    },
  };
  const sources = diagnosticSources(
    {
      localStream: () => undefined,
    } as unknown as AppStateContextProps,
    new PresentationDiagnostics(),
    {} as PlatformRuntime,
  );
  const state = await sources[0].state(false);
  expect(state).toMatchObject({
    nativeReceivers: [
      {
        sourceId: "screen",
        failed: true,
        errorCode: "0x80004005",
      },
    ],
  });
  expect(JSON.stringify(state)).not.toContain("secret.txt");
  expect(JSON.stringify(state)).not.toContain(
    "Decode failed",
  );
});
function handler(stream?: unknown) {
  const replace = vi.fn();
  const state = {
    localStream: () => stream,
    replaceLocalStream: replace,
  } as unknown as AppStateContextProps;
  return {
    replace,
    run: automationHandlers(
      state,
      { capture: {}, screenShare: {} } as PlatformRuntime,
      {} as AutomationDiagnostics,
    ),
  };
}
it("reports no local shell or signals in a browser and uses the native backend when present", async () => {
  const { run } = handler();
  const call = {
    name: "commands.capabilities",
    arguments: { target: "local" },
  };
  const schema = parseCall(call).outputSchema;
  const signal = new AbortController().signal;
  const browser = await run(call, signal);
  expect(browser).toEqual({
    supported: false,
    transport: "none",
    stdin: false,
    eof: false,
    pty: false,
    supportedSignals: [],
    signalSemantics: {},
  });
  expect(
    validate(schema, { ok: true, data: browser }),
  ).toBe(true);
  const windows = {
    supported: true,
    transport: "pipe",
    stdin: true,
    eof: true,
    pty: false,
    supportedSignals: ["SIGTERM", "SIGKILL"],
    signalSemantics: {
      SIGTERM: "terminate-process-tree",
      SIGKILL: "terminate-process-tree",
    },
  };
  const native = vi.fn(async () => windows);
  expect(await run(call, signal, native)).toBe(windows);
  expect(native).toHaveBeenCalledOnce();
  expect(
    validate(schema, { ok: true, data: windows }),
  ).toBe(true);
  expect(
    validate(schema, {
      ok: false,
      error: {
        code: "UNSUPPORTED",
        message: "Unknown tool",
      },
    }),
  ).toBe(true);
  expect(
    validate(schema, {
      ok: true,
      data: { ...windows, supportedSignals: ["SIGSTOP"] },
    }),
  ).toBe(false);
});

it("does not query native command capabilities after cancellation or permission revocation", async () => {
  const { run } = handler();
  const call = {
    name: "commands.capabilities",
    arguments: { target: "local" },
  };
  const native = vi.fn(async () => ({}));
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(
    run(call, cancelled.signal, native),
  ).rejects.toThrow();
  await expect(
    run(
      call,
      new AbortController().signal,
      native,
      async () => {
        throw new Error("GRANT_EXPIRED");
      },
    ),
  ).rejects.toThrow("GRANT_EXPIRED");
  expect(native).not.toHaveBeenCalled();
});

it("rechecks permission after async capture and disposes a stream before publishing it", async () => {
  const { run, replace } = handler();
  let resolve!: (stream: unknown) => void;
  fixture.capture.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  let allowed = true;
  const check = async () => {
    if (!allowed) throw new Error("GRANT_EXPIRED");
  };
  const result = run(
    {
      name: "screen.start",
      arguments: { target: "local", sourceId: "screen" },
    },
    new AbortController().signal,
    undefined,
    check,
  );
  await vi.waitFor(() =>
    expect(fixture.capture).toHaveBeenCalled(),
  );
  allowed = false;
  const track = { stop: vi.fn() };
  resolve({ getTracks: () => [track] });
  await expect(result).rejects.toThrow("GRANT_EXPIRED");
  expect(track.stop).toHaveBeenCalledOnce();
  expect(replace).not.toHaveBeenCalled();
});
it("stops configuration before touching senders when permission ends during applyConstraints", async () => {
  let resolve!: () => void;
  const track = {
    id: "track",
    readyState: "live",
    applyConstraints: vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    ),
  };
  const sender = {
    track,
    getParameters: vi.fn(() => ({ encodings: [{}] })),
    setParameters: vi.fn(),
  };
  fixture.sessions = {
    peer: {
      peerConnection: { getSenders: () => [sender] },
    },
  };
  const { run } = handler({
    getVideoTracks: () => [track],
  });
  let allowed = true;
  const check = async () => {
    if (!allowed) throw new Error("GRANT_EXPIRED");
  };
  const result = run(
    {
      name: "screen.configure",
      arguments: {
        target: "local",
        trackId: "track",
        maxWidth: 100,
        maxHeight: 100,
        frameRate: 30,
        maxBitrate: 10000,
      },
    },
    new AbortController().signal,
    undefined,
    check,
  );
  await vi.waitFor(() =>
    expect(track.applyConstraints).toHaveBeenCalled(),
  );
  allowed = false;
  resolve();
  await expect(result).rejects.toThrow("GRANT_EXPIRED");
  expect(sender.setParameters).not.toHaveBeenCalled();
});
