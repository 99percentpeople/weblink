import {
  getNativeCaptureStatus,
  getNativeScreenPublication,
} from "./native-screen-service";
import { registerScreenStream } from "./meeting-media-service";

interface ScreenSharingPort {
  stream(): MediaStream | null;
  publish(stream: MediaStream): void;
  /** A live native grant also owns its screen, including a completed handoff. */
  controlledSource?(): string | undefined;
  controller?():
    | { sourceId: string; clientId: string }
    | undefined;
}

export interface SharedScreen {
  trackId: string;
  sourceId: string;
  reused: boolean;
  stream: MediaStream;
  /** Reusing a picture never transfers its creator's close permission. */
  readonly createdByCaller: boolean;
  canClose(): boolean;
  close(): boolean;
  /** Releases only this control request's temporary ownership. */
  release(): void;
}

interface Publication {
  track: MediaStreamTrack;
  stream: MediaStream;
  persistent: boolean;
  requesterId?: string;
  owners: Set<symbol>;
}

/** One application owner serializes every native share of the same source. */
export function createScreenSharing(
  port: ScreenSharingPort,
) {
  const pending = new Map<string, Promise<unknown>>();
  const publications = new Map<
    MediaStreamTrack,
    Publication
  >();
  const existing = (sourceId: string) =>
    port
      .stream()
      ?.getVideoTracks()
      .find((track) => {
        const capture = getNativeCaptureStatus(track);
        return (
          track.readyState === "live" &&
          capture?.state === "running" &&
          capture.source?.id === sourceId
        );
      });
  const remove = (publication: Publication) => {
    const controlled = port.controlledSource?.();
    if (
      controlled &&
      getNativeScreenPublication(publication.track)
        ?.sourceId === controlled
    )
      return;
    publications.delete(publication.track);
    const owned = new Set(publication.stream.getTracks());
    const current = port.stream();
    if (
      current?.getTracks().some((track) => owned.has(track))
    )
      port.publish(
        new MediaStream(
          current
            .getTracks()
            .filter((track) => !owned.has(track)),
        ),
      );
  };
  const retain = (track: MediaStreamTrack) => {
    const publication = publications.get(track);
    if (publication) publication.persistent = true;
  };
  const stop = (track: MediaStreamTrack) => {
    const publication = publications.get(track);
    if (!publication) return;
    publications.delete(track);
    const owned = new Set(publication.stream.getTracks());
    const current = port.stream();
    if (
      current?.getTracks().some((track) => owned.has(track))
    )
      port.publish(
        new MediaStream(
          current
            .getTracks()
            .filter((track) => !owned.has(track)),
        ),
      );
  };
  const synchronize = () => {
    const live = new Set<MediaStreamTrack>(
      port.stream()?.getVideoTracks() ?? [],
    );
    for (const [track, publication] of publications) {
      if (!live.has(track) || track.readyState !== "live")
        publications.delete(track);
      else if (
        !publication.persistent &&
        !publication.owners.size
      )
        remove(publication);
    }
  };
  const claim = (
    publication: Publication,
    sourceId: string,
    reused: boolean,
    temporary: boolean,
    requesterId?: string,
  ): SharedScreen => {
    if (!temporary) {
      publication.persistent = true;
      publication.requesterId = undefined;
    }
    const owner = Symbol();
    publication.owners.add(owner);
    let released = false;
    const createdByCaller = () =>
      !!requesterId &&
      publication.requesterId === requesterId;
    const canClose = () => {
      if (
        !createdByCaller() ||
        publications.get(publication.track) !==
          publication ||
        publication.track.readyState !== "live"
      )
        return false;
      const control = port.controller?.();
      return (
        !control ||
        control.sourceId !==
          getNativeScreenPublication(publication.track)
            ?.sourceId ||
        control.clientId === requesterId
      );
    };
    return {
      trackId: publication.track.id,
      sourceId,
      reused,
      stream: publication.stream,
      get createdByCaller() {
        return createdByCaller();
      },
      canClose,
      close: () => {
        if (!canClose()) return false;
        stop(publication.track);
        return true;
      },
      release: () => {
        if (released) return;
        released = true;
        publication.owners.delete(owner);
        if (
          !publication.persistent &&
          !publication.owners.size
        )
          remove(publication);
      },
    };
  };
  const reuse = (track: MediaStreamTrack) => {
    let publication = publications.get(track);
    if (!publication) {
      // Streams published before this owner existed belong to the user.
      const capture = getNativeCaptureStatus(track);
      publication = {
        track,
        persistent: true,
        owners: new Set(),
        stream: new MediaStream(
          port
            .stream()!
            .getTracks()
            .filter(
              (t) =>
                t === track ||
                (capture?.sessionId &&
                  getNativeCaptureStatus(t)?.sessionId ===
                    capture.sessionId),
            ),
        ),
      };
      publications.set(track, publication);
    }
    return publication;
  };
  const start = async (
    sourceId: string,
    signal: AbortSignal,
    capture: () => Promise<MediaStream>,
    check: () => Promise<void> = async () => {},
    temporary = false,
    requesterId?: string,
  ): Promise<SharedScreen> => {
    const request = (
      pending.get(sourceId) ?? Promise.resolve()
    )
      .catch(() => {})
      .then(async () => {
        await check();
        signal.throwIfAborted();
        const shared = existing(sourceId);
        if (shared)
          return claim(
            reuse(shared),
            sourceId,
            true,
            temporary,
            requesterId,
          );
        const stream = await capture();
        const stop = () =>
          stream
            .getTracks()
            .forEach((track) => track.stop());
        try {
          await check();
          signal.throwIfAborted();
          const shared = existing(sourceId);
          if (shared) {
            stop();
            return claim(
              reuse(shared),
              sourceId,
              true,
              temporary,
              requesterId,
            );
          }
          const track = stream
            .getVideoTracks()
            .find((t) => t.readyState === "live");
          if (!track)
            throw new Error("Native screen closed");
          const publication: Publication = {
            track,
            stream,
            persistent: !temporary,
            requesterId: temporary
              ? requesterId
              : undefined,
            owners: new Set(),
          };
          registerScreenStream(stream);
          publications.set(track, publication);
          track.addEventListener(
            "ended",
            () => publications.delete(track),
            { once: true },
          );
          // Reactive publication can immediately run lifetime cleanup.
          const owned = claim(
            publication,
            sourceId,
            false,
            temporary,
            requesterId,
          );
          port.publish(
            new MediaStream([
              ...(port.stream()?.getTracks() ?? []),
              ...stream.getTracks(),
            ]),
          );
          return owned;
        } catch (error) {
          stream
            .getVideoTracks()
            .forEach((track) => publications.delete(track));
          stop();
          throw error;
        }
      });
    pending.set(sourceId, request);
    try {
      return await request;
    } finally {
      if (pending.get(sourceId) === request)
        pending.delete(sourceId);
    }
  };
  return { start, retain, stop, synchronize };
}

export type ScreenSharing = ReturnType<
  typeof createScreenSharing
>;
