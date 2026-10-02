import { createComponent, lazy, onCleanup } from "solid-js";
import {
  useLocation,
  useNavigate,
  type RouteSectionProps,
} from "@solidjs/router";
import { platform } from "@/libs/platform/runtime";
import { createLocalStreamService } from "@/libs/application/local-stream-service";
import { createSpeedTestApproval } from "@/components/speed-test-approval";
import { createRoomDialog } from "@/components/dialogs/join-dialog";
import { createNativeScreenDialog } from "@/components/dialogs/native-screen-dialog";
import { createMeetingMainViewConfirmation } from "@/routes/home/components/meeting-main-view-dialog";
import { AppStateContext } from "./app-state-context";
import { AudioPlayerContext } from "./audio-player-context";
import { MeetingMediaContext } from "./meeting-media-context";
import { RoomActionsContext } from "./room-actions-context";
import {
  MeetingSessionContext,
  type MeetingSession,
} from "./meeting-session-context";
import { AppDialogsContext } from "./app-dialogs-context";
import { createAppState } from "./create-app-state";
import {
  createAudioPlayer,
  type AudioPlayerController,
} from "./create-audio-player";
import { createMeetingMedia } from "./create-meeting-media";
import { createRoomActions } from "@/libs/state/create-room-actions";
import { createMeetingSession } from "./create-meeting-session";
import { createAppDialogs } from "./create-app-dialogs";
import { initializeApplication } from "./initialize-application";
import { provideContext } from "./provide-context";
import {
  defaultViewScopes,
  ViewScopesContext,
} from "./view-scopes";

const App = lazy(() => import("@/app"));

export interface ApplicationRuntime {
  readonly audio: AudioPlayerController;
  readonly meeting: MeetingSession;
  readonly confirmation: ReturnType<
    typeof createMeetingMainViewConfirmation
  >;
}

/** Plain TS composition owns resources; component refresh replaces only the views below it. */
export function createApplicationRoot(
  props: RouteSectionProps,
) {
  initializeApplication();
  const stream = createLocalStreamService();
  onCleanup(() => stream.dispose());
  const state = createAppState(
    stream,
    createSpeedTestApproval(),
  );
  return provideContext(
    ViewScopesContext,
    defaultViewScopes,
    () =>
      provideContext(AppStateContext, state, () => {
        const audio = createAudioPlayer();
        return provideContext(
          AudioPlayerContext,
          audio.value,
          () => {
            const media = createMeetingMedia({
              state,
              audio: audio.value,
              nativePicker:
                platform.capture && platform.screenShare
                  ? createNativeScreenDialog(
                      platform.capture,
                    )
                  : undefined,
            });
            return provideContext(
              MeetingMediaContext,
              media,
              () => {
                const actions = createRoomActions({
                  state,
                  dialog: createRoomDialog(),
                });
                return provideContext(
                  RoomActionsContext,
                  actions,
                  () => {
                    const confirmation =
                      createMeetingMainViewConfirmation();
                    const meeting = createMeetingSession({
                      state,
                      media,
                      location: useLocation(),
                      navigate: useNavigate(),
                      confirmation,
                    });
                    return provideContext(
                      MeetingSessionContext,
                      meeting,
                      () => {
                        const dialogs = createAppDialogs();
                        return provideContext(
                          AppDialogsContext,
                          dialogs,
                          () =>
                            createComponent(App, {
                              runtime: {
                                audio,
                                meeting,
                                confirmation,
                              },
                              get children() {
                                return props.children;
                              },
                              get params() {
                                return props.params;
                              },
                              get location() {
                                return props.location;
                              },
                              get data() {
                                return props.data;
                              },
                            }),
                        );
                      },
                    );
                  },
                );
              },
            );
          },
        );
      }),
  );
}
