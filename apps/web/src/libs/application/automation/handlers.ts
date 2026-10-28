import { sanitizePipeline } from "./pipeline-diagnostics";
import type { PresentationDiagnostics } from "./presentation";
import { nativeScreenOptions } from "../meeting-video-settings";
import {
  AutomationError,
  type ToolCall,
} from "@weblink/automation";
import type {
  PlatformRuntime,
  NativeVideoSettings,
} from "@weblink/platform";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import { createScreenSettings } from "./screen-settings";
import {
  AutomationScreenShares,
  type AutomationScreenAuthority,
} from "./screen-sharing";
import { sessionService } from "../session-service";
import {
  createNativeScreenStream,
  getNativeScreenPublication,
  getNativeCaptureStatus,
} from "../native-screen-service";
import type { AutomationDiagnostics } from "./diagnostics";
import {
  automationDeviceDiscovery,
  localAutomationCapability,
  type DeviceDiscoverySource,
} from "./device-discovery";
export function automationHandlers(
  state: AppStateContextProps,
  platform: PlatformRuntime,
  diagnostics: AutomationDiagnostics,
  discovery?: DeviceDiscoverySource,
  shares = new AutomationScreenShares(state.screenSharing),
) {
  const screenSettings = createScreenSettings({
    platform,
    read: () => appState.options,
    write: (patch) => setAppState("options", patch),
  });
  const shareScreen = async (
    sourceId: string,
    signal: AbortSignal,
    check: () => Promise<void>,
    owner?: string,
    purpose: "screen" | "control" = "screen",
    requesterId?: string,
  ) => {
    const shared = await shares.start(
      owner,
      sourceId,
      signal,
      async (signal) => {
        if (!platform.capture || !platform.screenShare)
          throw new AutomationError("UNSUPPORTED");
        return createNativeScreenStream(
          platform.capture,
          platform.screenShare,
          sourceId,
          signal,
          {
            ...nativeScreenOptions(appState.options),
            audio: false,
          },
          {
            backend:
              appState.options.nativeScreenCaptureBackend,
          },
        );
      },
      check,
      purpose,
      requesterId,
    );
    const { trackId, reused } = shared;
    return { trackId, sourceId, reused };
  };
  const localTrack = (id: unknown) => {
    const track = state
      .localStream()
      ?.getVideoTracks()
      .find((t) => t.id === id && t.readyState === "live");
    if (!track)
      throw new AutomationError("RESOURCE_CLOSED");
    return track;
  };
  return async (
    call: ToolCall,
    signal: AbortSignal,
    native?: (
      binding?: Record<string, string>,
    ) => Promise<Record<string, unknown>>,
    check: () => Promise<void> = async () =>
      signal.throwIfAborted(),
    authority?: AutomationScreenAuthority,
  ): Promise<Record<string, unknown>> => {
    await check();
    signal.throwIfAborted();
    const args = call.arguments;
    switch (call.name) {
      case "screen.settings.get":
      case "screen.settings.update":
        return screenSettings(call, signal, check);
      case "commands.capabilities":
        return native
          ? native()
          : {
              supported: false,
              transport: "none",
              stdin: false,
              eof: false,
              pty: false,
              supportedSignals: [],
              signalSemantics: {},
            };
      case "accessibility.capabilities":
        return native
          ? native()
          : {
              supported: false,
              backend: null,
              actions: [],
            };
      case "devices.list":
        return {
          devices: [
            {
              id: "local",
              ...automationDeviceDiscovery(
                discovery?.local() ??
                  localAutomationCapability(
                    platform,
                    undefined,
                    false,
                    true,
                  ),
                "local",
              ),
            },
            ...Object.values(sessionService.sessions).map(
              (s) => {
                const capability =
                  sessionService.capabilities.get(
                    s,
                  )?.automation;
                return {
                  id: s.targetClientId,
                  name: sessionService.clientViewData[
                    s.targetClientId
                  ]?.name,
                  automation: !!capability,
                  connection:
                    s.peerConnection?.connectionState,
                  ...automationDeviceDiscovery(
                    capability,
                    discovery?.connection(
                      s.targetClientId,
                    ) ?? "unknown",
                  ),
                };
              },
            ),
          ],
        };
      case "sessions.list":
        return {
          localTracks:
            state
              .localStream()
              ?.getVideoTracks()
              .map((t) => ({
                id: t.id,
                state: t.readyState,
                sourceId:
                  getNativeScreenPublication(t)?.sourceId,
                captureSourceId:
                  getNativeCaptureStatus(t)?.source?.id,
                settings: t.getSettings(),
              })) ?? [],
          peers: Object.values(sessionService.sessions).map(
            (s) => ({
              id: s.targetClientId,
              connection: s.peerConnection?.connectionState,
              ice: s.peerConnection?.iceConnectionState,
              streams: sessionService.clientViewData[
                s.targetClientId
              ]?.nativeScreenViews?.map((v) => ({
                id: v.sourceId,
                error: v.error ?? null,
              })),
            }),
          ),
        };
      case "screen.start": {
        if (!platform.capture || !platform.screenShare)
          throw new AutomationError("UNSUPPORTED");
        const result = await shareScreen(
          String(args.sourceId),
          signal,
          check,
          authority?.grantId,
          "screen",
          authority?.requesterId,
        );
        signal.throwIfAborted();
        shares.retain(authority?.grantId, result.trackId);
        return result;
      }
      case "screen.stop": {
        const track = localTrack(args.trackId);
        if (
          !getNativeScreenPublication(track) &&
          !track.getSettings().displaySurface
        )
          throw new AutomationError("INVALID_TARGET");
        return shares.stop(
          authority?.screenGrantIds ?? [],
          track.id,
        );
      }
      case "screen.configure": {
        const track = localTrack(args.trackId);
        const publication =
          getNativeScreenPublication(track);
        const settings: NativeVideoSettings = {
          maxWidth: Number(args.maxWidth),
          maxHeight: Number(args.maxHeight),
          frameRate: Number(args.frameRate),
          maxBitrate: Number(args.maxBitrate),
          degradationPreference:
            appState.options.degradationPreference,
        };
        if (publication?.updateVideoSettings)
          await publication.updateVideoSettings(settings);
        else {
          await track.applyConstraints({
            width: { max: settings.maxWidth },
            height: { max: settings.maxHeight },
            frameRate: { max: settings.frameRate },
          });
          for (const session of Object.values(
            sessionService.sessions,
          )) {
            await check();
            signal.throwIfAborted();
            const sender = session.peerConnection
              ?.getSenders()
              .find((s) => s.track === track);
            if (!sender) continue;
            const p = sender.getParameters();
            if (!p.encodings?.length) continue;
            p.encodings.forEach(
              (e) => (e.maxBitrate = settings.maxBitrate),
            );
            await sender.setParameters(p);
          }
        }
        return { applied: true, settings };
      }
      case "control.acquire": {
        let trackId = args.trackId;
        let shareReused: boolean | undefined;
        try {
          if (typeof args.sourceId === "string") {
            if (!native)
              throw new AutomationError("UNSUPPORTED");
            const shared = await shareScreen(
              args.sourceId,
              signal,
              check,
              authority?.screenGrantId,
              "control",
              authority?.requesterId,
            );
            trackId = shared.trackId;
            shareReused = shared.reused;
          }
          const track = localTrack(trackId);
          const capture = getNativeCaptureStatus(track);
          const sourceId =
            getNativeScreenPublication(track)?.sourceId;
          if (!native || !capture?.sessionId || !sourceId)
            throw new AutomationError("CAPTURE_REQUIRED");
          await check();
          signal.throwIfAborted();
          const {
            controlLeaseId: _controlLeaseId,
            ...result
          } = await native({
            sessionId: capture.sessionId,
            sourceId,
          });
          signal.throwIfAborted();
          for (const id of authority?.screenGrantIds ?? [])
            shares.retain(id, track.id);
          return {
            ...result,
            trackId: track.id,
            ...(shareReused === undefined
              ? {}
              : { shareReused }),
          };
        } catch (error) {
          if (typeof trackId === "string")
            for (const id of authority?.screenGrantIds ??
              [])
              shares.failedAcquire(id, trackId);
          throw error;
        }
      }
      case "control.release": {
        if (!native)
          throw new AutomationError("UNSUPPORTED");
        return native();
      }
      case "diagnostics.snapshot":
        return diagnostics.snapshot();
      case "diagnostics.history":
        return diagnostics.read(Number(args.after ?? 0));
      case "diagnostics.export":
        return {
          format: "weblink-diagnostics/1",
          generatedAt: Date.now(),
          runtime: await platform.getCapabilities(),
          ...diagnostics.read(Number(args.after ?? 0)),
        };
      case "diagnostics.start":
        return diagnostics.detail(
          Number(args.durationMs ?? 300000),
        );
      case "diagnostics.stop":
        return diagnostics.detail(0);
      default:
        if (native) return native();
        throw new AutomationError("UNSUPPORTED");
    }
  };
}
export function diagnosticSources(
  state: AppStateContextProps,
  presentation: PresentationDiagnostics,
  platform: PlatformRuntime,
) {
  const tracks = new Set<MediaStreamTrack>(
    state.localStream()?.getVideoTracks() ?? [],
  );
  for (const view of Object.values(
    sessionService.clientViewData,
  ))
    for (const stream of [
      view.stream,
      view.nativeScreenStream,
    ])
      for (const track of stream?.getVideoTracks() ?? [])
        tracks.add(track);
  const streams = [...tracks]
    .filter((t) => t.readyState === "live")
    .map((track) => ({
      id: track.id,
      read: () => sessionService.getVideoStats(track),
      state: async (detailed: boolean) => {
        const capture = getNativeCaptureStatus(track);
        let pipeline: Record<string, unknown> | undefined;
        if (
          detailed &&
          capture?.sessionId &&
          state.runtimeCapabilities()?.nativeScreenCapture
        ) {
          try {
            const raw =
              await platform.screenShare?.pipelineStats?.(
                capture.sessionId!,
              );
            if (raw)
              pipeline = sanitizePipeline(raw) as Record<
                string,
                unknown
              >;
          } catch {
            pipeline = { unavailable: true };
          }
        }
        return {
          pipeline,
          presentation: presentation.read(track),
          readyState: track.readyState,
          muted: track.muted,
          capture: capture
            ? {
                state: capture.state,
                frames: capture.frames,
                fps: capture.fps,
                lastFrameAgeMs: capture.lastFrameAgeMs,
                failed: !!capture.error,
                errorCode:
                  capture.error?.match(
                    /0x[0-9a-f]{8}/i,
                  )?.[0] ?? null,
              }
            : undefined,
        };
      },
    }));
  const connections = Object.values(sessionService.sessions)
    .filter(
      (session) =>
        tracks.size > 0 ||
        sessionService.clientViewData[
          session.targetClientId
        ]?.nativeScreenViews?.length,
    )
    .map((session) => ({
      id: `connection:${session.targetClientId}`,
      read: async () => [],
      state: async () => {
        const pc = session.peerConnection;
        let transport: Record<string, unknown> = {};
        if (pc)
          try {
            const reports = await pc.getStats();
            let selected: string | undefined;
            reports.forEach((report) => {
              if (
                report.type === "transport" &&
                report.selectedCandidatePairId
              )
                selected = report.selectedCandidatePairId;
            });
            const pair = selected
              ? reports.get(selected)
              : undefined;
            if (pair) {
              const local = reports.get(
                  pair.localCandidateId,
                ),
                remote = reports.get(
                  pair.remoteCandidateId,
                );
              transport = {
                rttMs:
                  typeof pair.currentRoundTripTime ===
                  "number"
                    ? pair.currentRoundTripTime * 1000
                    : undefined,
                bytesSent: pair.bytesSent,
                bytesReceived: pair.bytesReceived,
                availableOutgoingBitrate:
                  pair.availableOutgoingBitrate,
                route: [
                  local?.candidateType,
                  remote?.candidateType,
                ],
              };
            }
          } catch {
            transport = { statsUnavailable: true };
          }
        return {
          kind: "connection",
          connectionState: pc?.connectionState ?? "closed",
          iceState: pc?.iceConnectionState ?? "closed",
          transport,
          nativeReceivers:
            sessionService.clientViewData[
              session.targetClientId
            ]?.nativeScreenViews?.map((v) => ({
              sourceId: v.sourceId,
              failed: !!v.error,
              errorCode:
                v.error?.match(/0x[0-9a-f]{8}/i)?.[0] ??
                null,
              hasStream: !!v.stream,
            })) ?? [],
        };
      },
    }));
  return [...streams, ...connections];
}
