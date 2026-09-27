import { createMemo, type Accessor } from "solid-js";
import { t } from "@/i18n";
import { getMeetingVideoSourceKind } from "./meeting-media";
import { getMeetingAudioSource } from "@/libs/application/meeting-media-service";
import {
  getRemoteAudioVideoTrackId,
  meetingAudioSourceId,
  type RemoteAudioSources,
} from "./meeting-audio-sources";
import type { StreamVideoSource } from "@/libs/domain/protocol/messages";
import type { RemoteMediaTrackBinding } from "@/libs/domain/session-media";

export interface MeetingParticipant extends RemoteAudioSources {
  id: string;
  name: string;
  avatar?: string;
  stream?: MediaStream | null;
  videoSources?: readonly StreamVideoSource[];
  videoTracks?: readonly RemoteMediaTrackBinding[];
  local?: boolean;
  placeholder?: boolean;
}

export interface MeetingSource {
  id: string;
  participantId: string;
  audioId: string;
  name: string;
  avatar?: string;
  stream: MediaStream | null;
  local: boolean;
  kind: "camera" | "screen" | "video" | "participant";
  track?: MediaStreamTrack;
}

export function selectMeetingFeaturedSource(
  sources: readonly MeetingSource[],
  pinnedId: string | null,
): MeetingSource | undefined {
  const pinned = sources.find(
    (source) => source.id === pinnedId,
  );
  if (pinned) return pinned;
  // A single tile fills the main view in either layout, regardless of owner.
  // Multiple tiles keep the selected layout, including multiple local tracks.
  return sources.length === 1 ? sources[0] : undefined;
}

export function selectMeetingVideoSource(
  sources: readonly MeetingSource[],
): MeetingSource | undefined {
  return sources.find(
    (source) =>
      source.track?.kind === "video" &&
      source.track.readyState !== "ended",
  );
}

export function selectMeetingPipSource(
  sources: readonly MeetingSource[],
  pinnedId: string | null,
): MeetingSource | undefined {
  return (
    sources.find((source) => source.id === pinnedId) ??
    selectMeetingVideoSource(sources) ??
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
        const kindByMid = new Map(
          participant.videoSources?.map((source) => [
            source.mid,
            source.kind,
          ]) ?? [],
        );
        const midByTrackId = new Map(
          participant.videoTracks?.map((binding) => [
            binding.trackId,
            binding.mid,
          ]) ?? [],
        );
        const classified: Array<{
          track: MediaStreamTrack;
          kind: Exclude<
            MeetingSource["kind"],
            "participant"
          >;
        }> = video.map((track) => {
          if (participant.local)
            return {
              track,
              kind: getMeetingVideoSourceKind(track),
            };
          const mid = midByTrackId.get(track.id);
          return {
            track,
            kind: mid
              ? (kindByMid.get(mid) ?? "video")
              : "video",
          };
        });
        const primary = classified.filter(
          ({ kind }) => kind !== "screen",
        );
        const screens = classified.filter(
          ({ kind }) => kind === "screen",
        );
        const audioByVideo = new Map<
          string,
          MediaStreamTrack[]
        >();
        const microphone: MediaStreamTrack[] = [];
        for (const track of audio) {
          const local = participant.local
            ? getMeetingAudioSource(track)
            : undefined;
          const owner = participant.local
            ? local?.kind === "screen"
              ? local.videoTrack.id
              : undefined
            : getRemoteAudioVideoTrackId(
                track.id,
                participant,
              );
          if (
            owner &&
            classified.some(
              ({ track }) => track.id === owner,
            )
          ) {
            const group = audioByVideo.get(owner) ?? [];
            group.push(track);
            audioByVideo.set(owner, group);
          } else microphone.push(track);
        }
        const build = (
          track: MediaStreamTrack | undefined,
          kind: MeetingSource["kind"],
          includeAudio: boolean,
          label = "",
        ): MeetingSource => {
          const id = JSON.stringify([
            participant.id,
            track?.id ?? null,
          ]);
          const selected = [
            ...(track ? [track] : []),
            ...(track
              ? (audioByVideo.get(track.id) ?? [])
              : []),
            ...(includeAudio ? microphone : []),
          ];
          const previous = cache.get(id);
          const previousTracks = previous?.getTracks();
          const stream = selected.length
            ? previousTracks?.length === selected.length &&
              previousTracks.every(
                (item, i) => item === selected[i],
              )
              ? previous!
              : new MediaStream(selected)
            : null;
          if (stream) nextCache.set(id, stream);
          return {
            id,
            participantId: participant.id,
            audioId: meetingAudioSourceId(
              participant.id,
              kind === "screen" ||
                (track && audioByVideo.has(track.id))
                ? track?.id
                : undefined,
            ),
            name: label
              ? `${participant.name} · ${label}`
              : participant.name,
            avatar: participant.avatar,
            stream,
            local: participant.local === true,
            kind,
            track,
          };
        };

        // The participant owns microphone/avatar/camera presentation. Shared
        // screens are always additional tiles and never consume that identity.
        const main = primary.length
          ? primary.map(({ track, kind }, index) =>
              build(
                track,
                kind,
                index === 0,
                kind === "camera"
                  ? t("meeting.camera")
                  : primary.length > 1
                    ? t("meeting.video_source", {
                        count: index + 1,
                      })
                    : "",
              ),
            )
          : [build(undefined, "participant", true)];
        const shared = screens.map(({ track }, index) =>
          build(
            track,
            "screen",
            false,
            t("meeting.screen_source", {
              count: index + 1,
            }),
          ),
        );
        return [...main, ...shared];
      },
    );
    cache = nextCache;
    return sources;
  });
}
