import { batch, createSignal } from "solid-js";
import { render } from "solid-js/web";
import { createSessionService } from "@/libs/application/session-service";
import {
  AppStateContext,
  type AppStateContextProps,
} from "@/libs/state/app-state-context";
import { AudioPlayerContext } from "@/libs/state/audio-player-context";
import { MeetingStage } from "@/routes/home/components/meeting-stage";
import {
  createMeetingSources,
  type MeetingParticipant,
} from "@/routes/home/components/meeting-sources";
import "@/routes/home/index.css";

function assert(value: unknown, message: string): void {
  if (!value) throw new Error(message);
}
async function until(
  check: () => boolean,
  message: string,
) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
}

/** Use the real stage and a live received RTP stream; assert playback, not layout. */
export async function checkMeetingPlaybackMembership(
  stream: MediaStream,
) {
  for (const pinned of [false, true]) {
    const host = document.createElement("div");
    host.style.cssText =
      "position:relative;display:flex;width:800px;height:450px";
    document.body.append(host);
    const self: MeetingParticipant = {
      id: "self",
      name: "Self",
      local: true,
    };
    const peer: MeetingParticipant = {
      id: "peer",
      name: "Peer",
      stream,
    };
    let setParticipants!: (
      peers: MeetingParticipant[],
    ) => void;
    const dispose = render(() => {
      createSessionService();
      const [participants, set] = createSignal([
        self,
        peer,
      ]);
      setParticipants = set;
      const sources = createMeetingSources(participants);
      const pinnedId = pinned
        ? sources().find(
            (source) => source.participantId === peer.id,
          )!.id
        : null;
      return (
        <AppStateContext.Provider
          value={
            {
              peerCapabilities: () => undefined,
            } as unknown as AppStateContextProps
          }
        >
          <AudioPlayerContext.Provider
            value={{
              hasAudio: () => false,
              playState: () => false,
              setPlay() {},
              hasPeerAudio: () => false,
              isPeerMuted: () => true,
              setPeerMuted() {},
              isSourceMuted: () => true,
              setSourceMuted() {},
              outputDeviceId: () => "",
              outputSupported: () => false,
              outputBusy: () => false,
              async setOutputDevice() {},
            }}
          >
            <MeetingStage
              compact
              sources={sources()}
              pinnedId={pinnedId}
              railCollapsed={false}
              onRailCollapsedChange={() => {}}
              onPin={() => {}}
              onStop={() => {}}
              transitionLayout={(update) => batch(update)}
            />
          </AudioPlayerContext.Provider>
        </AppStateContext.Provider>
      );
    }, host);
    const lifetime = new AbortController();
    const findVideo = () =>
      host.querySelector<HTMLVideoElement>(
        `[data-track-id="${CSS.escape(stream.getVideoTracks()[0].id)}"] video`,
      );
    try {
      await until(() => {
        const video = findVideo();
        return (
          !!video && video.readyState >= 2 && !video.paused
        );
      }, `Meeting RTP playback did not start (pinned=${pinned})`);
      const video = findVideo()!;
      const attached = video.srcObject;
      const parent = video.parentElement;
      const interruptions: string[] = [];
      for (const type of ["emptied", "loadstart", "pause"])
        video.addEventListener(
          type,
          () => interruptions.push(type),
          { signal: lifetime.signal },
        );
      const frames = () =>
        video.getVideoPlaybackQuality().totalVideoFrames;
      const verify = async (next: MeetingParticipant[]) => {
        const before = frames();
        setParticipants(next);
        await until(
          () => frames() >= before + 4,
          `Membership stopped new frames (pinned=${pinned})`,
        );
        assert(
          findVideo() === video &&
            video.isConnected &&
            video.parentElement === parent,
          "unrelated membership must retain the existing video element",
        );
        assert(
          video.srcObject === attached && !video.paused,
          "unrelated membership must retain the playing stream",
        );
        assert(
          interruptions.length === 0,
          `membership interrupted playback: ${interruptions}`,
        );
      };
      const other = { id: "other", name: "Other" };
      await verify([{ ...self }, { ...peer }, other]);
      await verify([
        { ...self },
        { ...peer },
        { ...other, name: "Connected" },
      ]);
      await verify([{ ...self }, { ...peer }]);
    } finally {
      lifetime.abort();
      dispose();
      host.remove();
    }
    assert(
      stream.getVideoTracks()[0].readyState === "live",
      "stage cleanup must retain the borrowed RTP track",
    );
  }
  return { grid: true, pinned: true, uninterrupted: true };
}
