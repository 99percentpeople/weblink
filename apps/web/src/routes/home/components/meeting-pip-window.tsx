import { createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { useMeetingMedia } from "@/libs/hooks/meeting-media-context";
import { preparePictureInPictureDocument } from "@/libs/utils/picture-in-picture-document";
import { Toaster } from "@/components/ui/sonner";
import { useRoomActions } from "@/components/app/room-actions";
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
import {
  createMotionLayout,
  MotionLayout,
} from "@/components/ui/motion-layout";

export function MeetingPipWindow(props: {
  window: Window;
  sources: readonly MeetingSource[];
  featuredId: string | null;
  railCollapsed: boolean;
  onRailCollapsedChange(collapsed: boolean): void;
  toolbarCollapsed: boolean;
  onToolbarCollapsedChange(collapsed: boolean): void;
  onSelect(id: string): void;
  controls: MeetingPipControls;
  onLeave(): void;
}) {
  let page: HTMLElement | undefined;
  let stage: MeetingStageHandle | undefined;
  const layout = createMotionLayout({
    root: () => page,
    afterUpdate: () => stage?.measure(),
  });
  const transitionLayout = layout.transition;
  const displayedToolbarCollapsed = layout.value(
    () => props.toolbarCollapsed,
  );
  const { media } = useMeetingMedia();
  const roomActions = useRoomActions();
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
      <MotionLayout value={layout}>
        <main
          ref={page}
          class="meeting meeting-pip"
          classList={{
            "is-controls-collapsed":
              displayedToolbarCollapsed(),
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
            hideRailToggle={displayedToolbarCollapsed()}
            railCollapsed={props.railCollapsed}
            onRailCollapsedChange={
              props.onRailCollapsedChange
            }
            onPin={(id) =>
              transitionLayout(() => props.onSelect(id))
            }
            onStop={media.stopVideoTrack}
          />
          <MeetingControls
            collapsed={displayedToolbarCollapsed()}
            onCollapsedChange={
              props.onToolbarCollapsedChange
            }
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
            onJoin={() => {
              props.controls.returnToMeeting();
              void roomActions.join();
            }}
            joining={
              roomActions.busy() ||
              appState.session.clientServiceStatus ===
                "connecting"
            }
            onLeave={props.onLeave}
            pip={props.controls}
          />
          <Toaster position="top-center" />
        </main>
      </MotionLayout>
    </Portal>
  );
}
