import type { NativeVideoSettings } from "@weblink/platform";
import type { NativeScreenPublication } from "@/libs/domain/native-screen/session";
import {
  meetingVideoConstraints,
  nativeScreenOptions,
  type MeetingVideoSettings,
} from "./meeting-video-settings";

interface Update {
  key: string;
  apply(): Promise<void>;
}
interface Entry {
  track: MediaStreamTrack;
  attempted?: string;
  pending?: Update;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** Capture ownership stays with the media controller. This only updates its
 * live tracks, coalescing edits and serializing asynchronous device operations. */
export function createLiveVideoSettings(port: {
  publication(
    track: MediaStreamTrack,
  ): NativeScreenPublication | undefined;
  error(error: unknown): void;
}) {
  const entries = new Map<MediaStreamTrack, Entry>();
  let disposed = false;
  const active = (entry: Entry) =>
    !disposed &&
    entries.get(entry.track) === entry &&
    entry.track.readyState === "live";
  const drain = async (entry: Entry) => {
    if (entry.running || !active(entry)) return;
    entry.running = true;
    try {
      while (active(entry) && entry.pending) {
        const update = entry.pending;
        entry.pending = undefined;
        if (entry.attempted === update.key) continue;
        entry.attempted = update.key;
        try {
          await update.apply();
        } catch (error) {
          if (active(entry) && !entry.pending)
            port.error(error);
        }
      }
    } finally {
      entry.running = false;
    }
  };
  return {
    sync(
      stream: MediaStream | null,
      options: MeetingVideoSettings,
    ) {
      if (disposed) return;
      const tracks = new Set(
        stream
          ?.getVideoTracks()
          .filter((track) => track.readyState === "live") ??
          [],
      );
      for (const [track, entry] of entries) {
        if (tracks.has(track)) continue;
        clearTimeout(entry.timer);
        entries.delete(track);
      }
      // Exclude codec, encoder, backend, readback buffers and audio consent. Those
      // preferences only apply when a new capture/session is created.
      const {
        maxWidth,
        maxHeight,
        frameRate,
        maxBitrate,
        degradationPreference,
      } = nativeScreenOptions(options);
      const settings: NativeVideoSettings = {
        maxWidth,
        maxHeight,
        frameRate,
        maxBitrate,
        degradationPreference,
      };
      const constraints = meetingVideoConstraints(options);
      for (const track of tracks) {
        let entry = entries.get(track);
        if (!entry) {
          entry = { track, running: false };
          entries.set(track, entry);
        }
        const publication = port.publication(track);
        const key = JSON.stringify(
          publication ? settings : constraints,
        );
        if ((entry.pending?.key ?? entry.attempted) === key)
          continue;
        entry.pending = {
          key,
          apply: () =>
            publication
              ? (publication.updateVideoSettings?.(
                  settings,
                ) ??
                Promise.reject(
                  new Error(
                    "Live native video settings are unavailable",
                  ),
                ))
              : track.applyConstraints({
                  ...track.getConstraints(),
                  ...constraints,
                }),
        };
        clearTimeout(entry.timer);
        entry.timer = setTimeout(
          () => void drain(entry!),
          150,
        );
      }
    },
    dispose() {
      disposed = true;
      for (const entry of entries.values())
        clearTimeout(entry.timer);
      entries.clear();
    },
  };
}
