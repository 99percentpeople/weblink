import { createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { useMeetingMedia } from "@/libs/hooks/meeting-media-context";
import { preparePictureInPictureDocument } from "@/libs/utils/picture-in-picture-document";
import { Toaster } from "@/components/ui/sonner";
import { appState } from "@/libs/state/app-state";
import { t } from "@/i18n";
import { useAudioPlayer } from "./audio-player";
import {
  MeetingControls,
  type MeetingPipControls,
} from "./meeting-controls";
import type { MeetingSource } from "./meeting-sources";
import {
  MeetingStage,
  type MeetingStageHandle,
} from "./meeting-stage";
import { createLayoutTransition } from "@/libs/hooks/layout-transition";

export function MeetingPipWindow(props: {
  window: Window;
  sources: readonly MeetingSource[];
  featuredId: string | null;
  railCollapsed: boolean;
  onRailCollapsedChange(collapsed: boolean): void;
  toolbarFollowsRail: boolean;
  onSelect(id: string): void;
  controls: MeetingPipControls;
  onLeave(): void;
}) {
  let page: HTMLElement | undefined;
  let stage: MeetingStageHandle | undefined;
  const transitionLayout = createLayoutTransition(
    () => page,
    ".meeting-stage [data-motion-layout]",
    () => stage?.measure(),
  );
  const { media } = useMeetingMedia();
  const controlsCollapsed = () =>
    props.railCollapsed && props.toolbarFollowsRail;
  const audio = useAudioPlayer();
  const target = props.window.document;
  target.documentElement.dataset.meetingPip = "";
  onCleanup(
    preparePictureInPictureDocument(document, target),
  );
  createEffect(() => {
    target.title = t("meeting.pip_title");
  });
  return (
    <Portal mount={target.body}>
      <main
        ref={page}
        class="meeting meeting-pip"
        classList={{
          "is-controls-collapsed": controlsCollapsed(),
        }}
        aria-label={t("meeting.pip_title")}
      >
        <MeetingStage
          compact
          ref={(value) => {
            stage = value;
          }}
          transitionLayout={transitionLayout}
          sources={props.sources}
          pinnedId={props.featuredId}
          railCollapsed={props.railCollapsed}
          onRailCollapsedChange={
            props.onRailCollapsedChange
          }
          toolbarFollowsRail={props.toolbarFollowsRail}
          onPin={(id) =>
            transitionLayout(() => props.onSelect(id))
          }
          onStop={media.stopVideoTrack}
        />
        <MeetingControls
          collapsed={controlsCollapsed()}
          compact
          media={media}
          hasAudio={audio.hasAudio()}
          playingAudio={audio.playState()}
          onToggleAudio={() =>
            audio.setPlay(!audio.playState())
          }
          spotlight
          onToggleLayout={() => {}}
          joined={Boolean(appState.roomStatus.roomId)}
          onLeave={props.onLeave}
          pip={props.controls}
        />
        <Toaster position="top-center" />
      </main>
    </Portal>
  );
}
