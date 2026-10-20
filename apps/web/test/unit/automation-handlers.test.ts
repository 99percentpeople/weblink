import { afterEach, expect, it, vi } from "vitest";
import {
  automationHandlers,
  diagnosticSources,
} from "@/libs/application/automation/handlers";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import type { PlatformRuntime } from "@weblink/platform";
import type { AutomationDiagnostics } from "@/libs/application/automation/diagnostics";
import { PresentationDiagnostics } from "@/libs/application/automation/presentation";
const fixture = vi.hoisted(() => ({
  capture: vi.fn(),
  sessions: {} as Record<string, unknown>,
  views: {} as Record<string, unknown>,
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {
    get sessions() {
      return fixture.sessions;
    },
    get clientViewData() {
      return fixture.views;
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
  appState: { options: {} },
}));
afterEach(() => {
  vi.resetAllMocks();
  fixture.sessions = {};
  fixture.views = {};
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
