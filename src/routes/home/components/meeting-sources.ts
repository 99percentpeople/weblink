import { createMemo, type Accessor } from "solid-js";
import { t } from "@/i18n";
import { getMeetingVideoSourceKind } from "./meeting-media";

export interface MeetingParticipant {
  id: string;
  name: string;
  avatar?: string;
  stream?: MediaStream | null;
  local?: boolean;
  placeholder?: boolean;
}

export interface MeetingSource {
  id: string;
  participantId: string;
  name: string;
  avatar?: string;
  stream: MediaStream | null;
  local: boolean;
  kind: "camera" | "screen" | "video" | "participant";
  track?: MediaStreamTrack;
}

export function selectMeetingPipSource(
  sources: readonly MeetingSource[],
  pinnedId: string | null,
): MeetingSource | undefined {
  return (
    sources.find((source) => source.id === pinnedId) ??
    sources.find(
      (source) =>
        source.track?.kind === "video" &&
        source.track.readyState !== "ended",
    ) ??
    sources[0]
  );
}

/** Presentation-only streams borrow tracks; capture and RTC own their lifetimes. */
export function createMeetingSources(
  participants: Accessor<readonly MeetingParticipant[]>,
): Accessor<MeetingSource[]> {
  let cache = new Map<string, MediaStream>();
  return createMemo(() => {
    const nextCache = new Map<string, MediaStream>();
    const sources = participants().flatMap(
      (participant) => {
        const tracks =
          participant.stream
            ?.getTracks()
            .filter(
              (track) => track.readyState !== "ended",
            ) ?? [];
        const audio = tracks.filter(
          (track) => track.kind === "audio",
        );
        const video = participant.placeholder
          ? []
          : tracks.filter(
              (track) => track.kind === "video",
            );
        let screenIndex = 0;
        return (video.length ? video : [undefined]).map(
          (track, index) => {
            const id = JSON.stringify([
              participant.id,
              track?.id ?? null,
            ]);
            const kind = track
              ? participant.local
                ? getMeetingVideoSourceKind(track)
                : "video"
              : "participant";
            const selected = [
              ...(track ? [track] : []),
              ...(index === 0 ? audio : []),
            ];
            const previous = cache.get(id);
            const previousTracks = previous?.getTracks();
            const stream = selected.length
              ? previousTracks?.length ===
                  selected.length &&
                previousTracks.every(
                  (item, i) => item === selected[i],
                )
                ? previous!
                : new MediaStream(selected)
              : null;
            if (stream) nextCache.set(id, stream);
            const label =
              kind === "camera"
                ? t("meeting.camera")
                : kind === "screen"
                  ? t("meeting.screen_source", {
                      count: ++screenIndex,
                    })
                  : kind === "video" && video.length > 1
                    ? t("meeting.video_source", {
                        count: index + 1,
                      })
                    : "";
            return {
              id,
              participantId: participant.id,
              name: label
                ? `${participant.name} · ${label}`
                : participant.name,
              avatar: participant.avatar,
              stream,
              local: participant.local === true,
              kind,
              track,
            } satisfies MeetingSource;
          },
        );
      },
    );
    cache = nextCache;
    return sources;
  });
}
