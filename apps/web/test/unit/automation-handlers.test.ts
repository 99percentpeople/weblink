import { afterEach, expect, it, vi } from "vitest";
import {
  automationHandlers,
  diagnosticSources,
} from "@/libs/application/automation/handlers";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import { createScreenSharing } from "@/libs/application/screen-sharing";
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
  publications: new WeakMap<object, { sourceId: string }>(),
  captures: new WeakMap<
    object,
    {
      sessionId: string;
      state: string;
      source: { id: string };
    }
  >(),
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
  getNativeScreenPublication: (track: object) =>
    fixture.publications.get(track),
  getNativeCaptureStatus: (track: object) =>
    fixture.captures.get(track),
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
  vi.unstubAllGlobals();
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
  const replace = vi.fn((next: MediaStream) => {
    for (const track of (
      stream as MediaStream | undefined
    )?.getTracks?.() ?? [])
      if (!next.getTracks().includes(track)) track.stop();
    stream = next;
  });
  const state = {
    localStream: () => stream,
    replaceLocalStream: replace,
  } as unknown as AppStateContextProps;
  state.screenSharing = createScreenSharing({
    stream: state.localStream,
    publish: replace,
  });
  const handle = automationHandlers(
    state,
    { capture: {}, screenShare: {} } as PlatformRuntime,
    {} as AutomationDiagnostics,
  );
  return {
    replace,
    run: (...args: Parameters<typeof handle>) =>
      handle(
        args[0],
        args[1],
        args[2],
        args[3],
        args[4] ?? {
          grantId: "permission-1",
          requesterId: "caller",
          screenGrantIds: ["permission-1"],
        },
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

class ScreenStream {
  constructor(readonly tracks: MediaStreamTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}
function nativeScreen(sourceId = "monitor", id = "track") {
  vi.stubGlobal("MediaStream", ScreenStream);
  const track = {
    id,
    kind: "video",
    readyState: "live",
    getSettings: () => ({}),
    addEventListener: vi.fn(),
    stop: vi.fn(() => {
      track.readyState = "ended";
    }),
  };
  fixture.publications.set(track, {
    sourceId: `publication-${id}`,
  });
  fixture.captures.set(track, {
    sessionId: `capture-${id}`,
    state: "running",
    source: { id: sourceId },
  });
  return {
    track,
    stream: new ScreenStream([
      track as unknown as MediaStreamTrack,
    ]),
  };
}
const startScreen = {
  name: "screen.start",
  arguments: { target: "local", sourceId: "monitor" },
};
const acquireSource = {
  name: "control.acquire",
  arguments: { target: "local", sourceId: "monitor" },
};
const combinedAuthority = {
  grantId: "input-permission",
  requesterId: "caller",
  screenGrantId: "screen-permission",
  screenGrantIds: ["screen-permission"],
};
const acquiredControl = {
  acquired: true,
  reused: false,
  coordinateSpace: "desktopPhysicalPixels",
  sourceId: "monitor",
  geometryRevision: "geometry",
  bounds: { left: 0, top: 0, width: 1920, height: 1080 },
};
it("keeps the acquired screen after control.release until screen.stop", async () => {
  const { track, stream } = nativeScreen();
  const { run } = handler();
  fixture.capture.mockResolvedValue(stream);
  const signal = new AbortController().signal;
  const native = vi.fn(async () => ({
    ...acquiredControl,
    controlLeaseId: "lease",
  }));
  const result = await run(
    acquireSource,
    signal,
    native,
    undefined,
    combinedAuthority,
  );
  expect(result).toEqual({
    ...acquiredControl,
    trackId: track.id,
    shareReused: false,
  });
  expect(
    validate(parseCall(acquireSource).outputSchema, {
      ok: true,
      data: result,
    }),
  ).toBe(true);
  expect(fixture.capture).toHaveBeenCalledOnce();
  expect(fixture.capture.mock.calls[0][4]).toMatchObject({
    audio: false,
  });
  expect(native).toHaveBeenCalledWith({
    sessionId: "capture-track",
    sourceId: "publication-track",
  });
  expect(track.readyState).toBe("live");
  const repeated = await run(
    acquireSource,
    signal,
    native,
    undefined,
    combinedAuthority,
  );
  expect(repeated).toEqual({
    ...acquiredControl,
    trackId: track.id,
    shareReused: true,
  });
  expect(fixture.capture).toHaveBeenCalledOnce();
  await run(
    {
      name: "control.release",
      arguments: { target: "local" },
    },
    signal,
    async () => ({ released: true }),
    undefined,
    combinedAuthority,
  );
  expect(track.readyState).toBe("live");
  await run(
    {
      name: "screen.stop",
      arguments: { trackId: track.id },
    },
    signal,
    undefined,
    undefined,
    combinedAuthority,
  );
  expect(track.readyState).toBe("ended");
});

it("reuses a user share during combined acquisition and preserves it on release", async () => {
  const { track, stream } = nativeScreen();
  const { run } = handler(stream);
  const signal = new AbortController().signal;
  const result = await run(
    acquireSource,
    signal,
    async () => ({
      ...acquiredControl,
      controlLeaseId: "lease",
    }),
    undefined,
    combinedAuthority,
  );
  expect(result).toEqual({
    ...acquiredControl,
    trackId: track.id,
    shareReused: true,
  });
  expect(fixture.capture).not.toHaveBeenCalled();
  await run(
    { name: "control.release", arguments: {} },
    signal,
    async () => ({}),
    undefined,
    combinedAuthority,
  );
  expect(track.stop).not.toHaveBeenCalled();
});

it("never starts combined capture without its bound screen permission", async () => {
  nativeScreen();
  const { run } = handler();
  const native = vi.fn(async () => ({}));
  await expect(
    run(
      acquireSource,
      new AbortController().signal,
      native,
    ),
  ).rejects.toMatchObject({ code: "PERMISSION_DENIED" });
  expect(fixture.capture).not.toHaveBeenCalled();
  expect(native).not.toHaveBeenCalled();
});

it.each(["CONTROL_BUSY", "GRANT_EXPIRED"])(
  "releases the combined share after %s without replacing a previous monitor",
  async (reason) => {
    const old = nativeScreen(
      "previous-monitor",
      "previous",
    );
    const candidate = nativeScreen();
    const { run } = handler(old.stream);
    fixture.capture.mockResolvedValue(candidate.stream);
    await expect(
      run(
        acquireSource,
        new AbortController().signal,
        async () => {
          throw new Error(reason);
        },
        undefined,
        combinedAuthority,
      ),
    ).rejects.toThrow(reason);
    expect(candidate.track.readyState).toBe("ended");
    expect(old.track.readyState).toBe("live");
  },
);

it("discards a capture completed after combined acquisition was cancelled", async () => {
  const { track, stream } = nativeScreen();
  const { run } = handler();
  let finish!: (stream: ScreenStream) => void;
  fixture.capture.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const abort = new AbortController();
  const native = vi.fn(async () => ({}));
  const result = expect(
    run(
      acquireSource,
      abort.signal,
      native,
      undefined,
      combinedAuthority,
    ),
  ).rejects.toThrow();
  await vi.waitFor(() =>
    expect(fixture.capture).toHaveBeenCalledOnce(),
  );
  abort.abort();
  finish(stream);
  await result;
  expect(track.readyState).toBe("ended");
  expect(native).not.toHaveBeenCalled();
});
it("preserves an explicit screen across separately approved input permissions until screen.stop", async () => {
  const { track, stream } = nativeScreen();
  const { run } = handler();
  fixture.capture.mockResolvedValue(stream);
  const signal = new AbortController().signal;
  await run(startScreen, signal);
  const authority = {
    grantId: "input-permission",
    screenGrantIds: ["permission-1"],
  };
  const granted = await run(
    {
      name: "control.acquire",
      arguments: { trackId: track.id },
    },
    signal,
    async () => ({
      granted: true,
      controlLeaseId: "private-lease",
    }),
    undefined,
    authority,
  );
  expect(granted).toEqual({
    granted: true,
    trackId: track.id,
  });
  await run(
    { name: "control.release", arguments: {} },
    signal,
    async () => ({ released: true }),
    undefined,
    { grantId: "foreign", screenGrantIds: ["foreign"] },
  );
  expect(track.readyState).toBe("live");
  await run(
    { name: "control.release", arguments: {} },
    signal,
    async () => ({ released: true }),
    undefined,
    authority,
  );
  expect(track.readyState).toBe("live");
  await run(
    {
      name: "screen.stop",
      arguments: { trackId: track.id },
    },
    signal,
  );
  expect(track.readyState).toBe("ended");
});

it("does not let MCP close a manually shared picture even after reusing it", async () => {
  const { track, stream } = nativeScreen();
  const { run } = handler(stream);
  const signal = new AbortController().signal;
  const stop = {
    name: "screen.stop",
    arguments: { target: "local", trackId: track.id },
  };
  await expect(run(stop, signal)).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  await run(startScreen, signal);
  await expect(run(stop, signal)).rejects.toMatchObject({
    code: "PERMISSION_DENIED",
  });
  expect(track.readyState).toBe("live");
});

it("preserves explicit screen sharing when native acquisition fails", async () => {
  const { track, stream } = nativeScreen();
  const { run } = handler();
  const signal = new AbortController().signal;
  fixture.capture.mockResolvedValue(stream);
  await run(startScreen, signal);
  await expect(
    run(
      {
        name: "control.acquire",
        arguments: { trackId: track.id },
      },
      signal,
      async () => {
        throw new Error("CONTROL_BUSY");
      },
    ),
  ).rejects.toThrow("CONTROL_BUSY");
  expect(track.readyState).toBe("live");
  await run(
    {
      name: "screen.stop",
      arguments: { trackId: track.id },
    },
    signal,
  );
  expect(track.readyState).toBe("ended");
});

it("reuses the manually shared monitor, preserves its audio, and acquires the same capture", async () => {
  const { track, stream } = nativeScreen();
  const audio = {
    id: "audio",
    kind: "audio",
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  stream.tracks.push(audio);
  const { run, replace } = handler(stream);
  const signal = new AbortController();
  const started = await run(startScreen, signal.signal);
  expect(started).toEqual({
    trackId: track.id,
    sourceId: "monitor",
    reused: true,
  });
  const native = vi.fn(async () => ({ granted: true }));
  await run(
    {
      name: "control.acquire",
      arguments: { trackId: started.trackId },
    },
    signal.signal,
    native,
  );
  expect(native).toHaveBeenCalledWith({
    sessionId: "capture-track",
    sourceId: "publication-track",
  });
  const sessions = await run(
    { name: "sessions.list", arguments: {} },
    signal.signal,
  );
  expect(sessions.localTracks).toEqual([
    expect.objectContaining({
      id: track.id,
      sourceId: "publication-track",
      captureSourceId: "monitor",
    }),
  ]);
  signal.abort();
  expect(fixture.capture).not.toHaveBeenCalled();
  expect(replace).not.toHaveBeenCalled();
  expect(track.stop).not.toHaveBeenCalled();
  expect(audio.stop).not.toHaveBeenCalled();
});
it("serializes concurrent MCP starts and reuses the published track on repeated starts", async () => {
  const { track, stream } = nativeScreen();
  const { run, replace } = handler();
  let finish!: (value: ScreenStream) => void;
  fixture.capture.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const signal = new AbortController().signal;
  const first = run(startScreen, signal);
  const second = run(startScreen, signal);
  await vi.waitFor(() =>
    expect(fixture.capture).toHaveBeenCalled(),
  );
  expect(fixture.capture).toHaveBeenCalledOnce();
  finish(stream);
  expect(await first).toEqual({
    trackId: track.id,
    sourceId: "monitor",
    reused: false,
  });
  expect(await second).toEqual({
    trackId: track.id,
    sourceId: "monitor",
    reused: true,
  });
  expect(await run(startScreen, signal)).toEqual(
    await second,
  );
  expect(fixture.capture).toHaveBeenCalledOnce();
  expect(replace).toHaveBeenCalledOnce();
  expect(track.stop).not.toHaveBeenCalled();
});
it("uses a manual share published while MCP was capturing and disposes only its duplicate", async () => {
  const manual = nativeScreen("monitor", "manual");
  const created = nativeScreen("monitor", "mcp");
  const { run, replace } = handler();
  let finish!: (value: ScreenStream) => void;
  fixture.capture.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const pending = run(
    startScreen,
    new AbortController().signal,
  );
  await vi.waitFor(() =>
    expect(fixture.capture).toHaveBeenCalledOnce(),
  );
  replace(manual.stream as unknown as MediaStream);
  finish(created.stream);
  expect(await pending).toEqual({
    trackId: "manual",
    sourceId: "monitor",
    reused: true,
  });
  expect(created.track.stop).toHaveBeenCalledOnce();
  expect(manual.track.stop).not.toHaveBeenCalled();
  expect(replace).toHaveBeenCalledOnce();
});
it.each(["ended", "failed", "different source"])(
  "does not reuse a %s screen",
  async (reason) => {
    const old = nativeScreen(
      reason === "different source"
        ? "other-monitor"
        : "monitor",
      "old",
    );
    if (reason === "ended") old.track.stop();
    if (reason === "failed")
      fixture.captures.get(old.track)!.state = "failed";
    const next = nativeScreen("monitor", "next");
    const { run } = handler(old.stream);
    fixture.capture.mockResolvedValue(next.stream);
    expect(
      await run(startScreen, new AbortController().signal),
    ).toEqual({
      trackId: "next",
      sourceId: "monitor",
      reused: false,
    });
    expect(fixture.capture).toHaveBeenCalledOnce();
  },
);
it("rechecks a queued caller's grant without stopping another caller's shared screen", async () => {
  const { track, stream } = nativeScreen();
  const { run } = handler();
  let finish!: (value: ScreenStream) => void;
  fixture.capture.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const signal = new AbortController().signal;
  const first = run(startScreen, signal);
  let allowed = true;
  const check = vi.fn(async () => {
    if (!allowed) throw new Error("GRANT_EXPIRED");
  });
  const second = run(startScreen, signal, undefined, check);
  const rejected =
    expect(second).rejects.toThrow("GRANT_EXPIRED");
  await vi.waitFor(() =>
    expect(fixture.capture).toHaveBeenCalled(),
  );
  allowed = false;
  finish(stream);
  await first;
  await rejected;
  expect(track.stop).not.toHaveBeenCalled();
  expect(fixture.capture).toHaveBeenCalledOnce();
});
it("lets a queued caller retry after the first capture is cancelled without sharing its aborted lifetime", async () => {
  const cancelled = nativeScreen("monitor", "cancelled");
  const next = nativeScreen("monitor", "next");
  const { run, replace } = handler();
  let finish!: (value: ScreenStream) => void;
  fixture.capture
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(next.stream);
  const controller = new AbortController();
  const first = run(startScreen, controller.signal);
  const rejected = expect(first).rejects.toThrow();
  const second = run(
    startScreen,
    new AbortController().signal,
  );
  await vi.waitFor(() =>
    expect(fixture.capture).toHaveBeenCalledOnce(),
  );
  controller.abort();
  finish(cancelled.stream);
  await rejected;
  expect(await second).toEqual({
    trackId: "next",
    sourceId: "monitor",
    reused: false,
  });
  expect(cancelled.track.stop).toHaveBeenCalledOnce();
  expect(next.track.stop).not.toHaveBeenCalled();
  expect(replace).toHaveBeenCalledOnce();
  expect(fixture.capture).toHaveBeenCalledTimes(2);
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
  resolve({
    getTracks: () => [track],
    getVideoTracks: () => [track],
  });
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
