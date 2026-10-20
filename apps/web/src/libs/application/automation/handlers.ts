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
import { appState } from "@/libs/state/app-state";
import { sessionService } from "../session-service";
import {
  createNativeScreenStream,
  getNativeScreenPublication,
  getNativeCaptureStatus,
} from "../native-screen-service";
import type { AutomationDiagnostics } from "./diagnostics";
export function automationHandlers(
  state: AppStateContextProps,
  platform: PlatformRuntime,
  diagnostics: AutomationDiagnostics,
) {
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
  ): Promise<Record<string, unknown>> => {
    await check();
    signal.throwIfAborted();
    const args = call.arguments;
    switch (call.name) {
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
            { id: "local", runtime: platform.kind },
            ...Object.values(sessionService.sessions).map(
              (s) => ({
                id: s.targetClientId,
                name: sessionService.clientViewData[
                  s.targetClientId
                ]?.name,
                automation:
                  !!sessionService.capabilities.get(s)
                    ?.automation,
                connection:
                  s.peerConnection?.connectionState,
              }),
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
        const stream = await createNativeScreenStream(
          platform.capture,
          platform.screenShare,
          String(args.sourceId),
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
        try {
          await check();
          signal.throwIfAborted();
        } catch (error) {
          stream.getTracks().forEach((t) => t.stop());
          throw error;
        }
        const track = stream.getVideoTracks()[0];
        state.replaceLocalStream(
          new MediaStream([
            ...(state.localStream()?.getTracks() ?? []),
            ...stream.getTracks(),
          ]),
        );
        return {
          trackId: track.id,
          sourceId: args.sourceId,
        };
      }
      case "screen.stop": {
        const track = localTrack(args.trackId);
        if (
          !getNativeScreenPublication(track) &&
          !track.getSettings().displaySurface
        )
          throw new AutomationError("INVALID_TARGET");
        state.replaceLocalStream(
          new MediaStream(
            state
              .localStream()!
              .getTracks()
              .filter((t) => t !== track),
          ),
        );
        return { stopped: true };
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
        const track = localTrack(args.trackId);
        const capture = getNativeCaptureStatus(track);
        const sourceId =
          getNativeScreenPublication(track)?.sourceId;
        if (!native || !capture?.sessionId || !sourceId)
          throw new AutomationError("CAPTURE_REQUIRED");
        return native({
          sessionId: capture.sessionId,
          sourceId,
        });
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
            // Keep counters, stage timings and error codes; strip paths and arbitrary native strings.
            const sanitize = (
              value: unknown,
              depth = 0,
            ): unknown => {
              if (depth > 6) return undefined;
              if (typeof value === "number")
                return Number.isFinite(value)
                  ? value
                  : undefined;
              if (
                typeof value === "boolean" ||
                value === null
              )
                return value;
              if (typeof value === "string")
                return (
                  value.match(/0x[0-9a-f]{8}/gi) ??
                  undefined
                );
              if (Array.isArray(value))
                return value
                  .slice(0, 32)
                  .map((v) => sanitize(v, depth + 1));
              if (value && typeof value === "object")
                return Object.fromEntries(
                  Object.entries(value)
                    .slice(0, 64)
                    .map(([k, v]) => [
                      k,
                      sanitize(v, depth + 1),
                    ]),
                );
              return undefined;
            };
            if (raw)
              pipeline = sanitize(raw) as Record<
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
