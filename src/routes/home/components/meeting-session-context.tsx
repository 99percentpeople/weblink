import {
  createContext,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  Show,
  useContext,
  type ParentProps,
} from "solid-js";
import {
  useBeforeLeave,
  useLocation,
  useNavigate,
} from "@solidjs/router";
import {
  HOME_PATH,
  isHomePath,
} from "@/libs/application/home-navigation";
import { makePersisted } from "@solid-primitives/storage";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import { useMeetingMedia } from "@/libs/hooks/meeting-media-context";
import {
  createDocumentPictureInPicture,
  type DocumentPictureInPictureAPI,
} from "@/libs/hooks/document-picture-in-picture";
import { t } from "@/i18n";
import {
  createMeetingSources,
  selectMeetingPipSource,
} from "./meeting-sources";
import { reportMeetingPipError } from "./meeting-pip-error";
import { MeetingPipWindow } from "./meeting-pip-window";
import type { MeetingPipControls } from "./meeting-controls";
import "../index.css";

function createMeetingSession() {
  const state = useAppState();
  const { media } = useMeetingMedia();
  const location = useLocation();
  const navigate = useNavigate();
  const onMeetingPage = () => isHomePath(location.pathname);
  const [engaged, setEngaged] =
    createSignal(onMeetingPage());
  const [pinnedId, setPinnedId] = createSignal<
    string | null
  >(null);
  const [railCollapsed, setRailCollapsed] =
    createSignal(false);
  const [toolbarCollapsed, setToolbarCollapsed] =
    createSignal(false);
  const [automatic, setAutomatic] = makePersisted(
    createSignal(false),
    {
      name: "meeting-auto-picture-in-picture",
      storage: localStorage,
    },
  );
  let automaticReason: "route" | "background" | undefined;
  let dismissed = false;
  const pageHidden = () =>
    document.visibilityState === "hidden";
  const inForeground = () =>
    !pageHidden() && document.hasFocus();
  const clients = createMemo(() =>
    Object.values(appState.session.clientViewData).filter(
      Boolean,
    ),
  );
  const sources = createMeetingSources(() => [
    {
      id: appState.profile.clientId,
      name: `${appState.profile.name} (${t("meeting.you")})`,
      avatar: appState.profile.avatar ?? undefined,
      stream: state.localStream(),
      local: true,
    },
    ...clients().map((client) => ({
      id: client.clientId,
      name: client.name,
      avatar: client.avatar ?? undefined,
      stream: client.stream,
      placeholder: client.streamState === "placeholder",
    })),
  ]);
  const selected = createMemo(() =>
    selectMeetingPipSource(sources(), pinnedId()),
  );
  // Read track flags when opening: enabled/muted can change without a new stream.
  // Placeholder streams are already excluded from video sources.
  const hasSharedVideo = () =>
    sources().some(
      ({ track }) =>
        track?.kind === "video" &&
        track.readyState === "live" &&
        track.enabled &&
        !track.muted,
    );
  const pip = createDocumentPictureInPicture({
    api: (
      window as Window & {
        documentPictureInPicture?: DocumentPictureInPictureAPI;
      }
    ).documentPictureInPicture,
    onError: reportMeetingPipError,
    onClose: () => {
      // Suppress repeated background requests after a native dismissal, but a
      // browser close on return must not suppress the next departure.
      dismissed = !inForeground();
      automaticReason = undefined;
    },
  });
  const openAutomatically = (
    reason: "route" | "background",
    browserOccluded = false,
  ) => {
    if (
      !automatic() ||
      state.roomConflict() ||
      !engaged() ||
      !hasSharedVideo() ||
      (reason === "background" &&
        ((!pageHidden() && !browserOccluded) ||
          media.sharingBusy())) ||
      dismissed ||
      !pip.supported() ||
      pip.active() ||
      pip.busy()
    )
      return;
    automaticReason = reason;
    void pip.open().then(() => {
      // The last video may stop while the browser is creating its window.
      if (automaticReason && !hasSharedVideo()) {
        automaticReason = undefined;
        pip.close();
        return;
      }
      // Visibility can become visible while opening the child without the user
      // returning. Background requests are canceled by the foreground handlers.
      if (automaticReason === "route" && onMeetingPage()) {
        automaticReason = undefined;
        pip.close();
      }
    });
  };
  createEffect(
    on(state.roomConflict, (conflict) => {
      if (!conflict) {
        if (onMeetingPage()) setEngaged(true);
        return;
      }
      setEngaged(false);
      automaticReason = undefined;
      dismissed = true;
      pip.close();
      // Also cancel capture requests that may finish after the page is blocked.
      media.clear();
    }),
  );
  useBeforeLeave((event) => {
    if (!onMeetingPage() || event.defaultPrevented) return;
    if (
      typeof event.to === "string" &&
      isHomePath(
        new URL(event.to, window.location.href).pathname,
      )
    )
      return;
    if (event.to === 0) return;
    openAutomatically("route");
  });
  createEffect(
    on(onMeetingPage, (visible, previous) => {
      if (visible) {
        setEngaged(true);
        dismissed = false;
        if (
          previous === false &&
          automaticReason &&
          (automaticReason === "route" || inForeground())
        ) {
          automaticReason = undefined;
          pip.close();
        }
      }
    }),
  );
  // The browser grants activation for eligible tab switches/window occlusion.
  // Browser-reported occlusion can precede visibilitychange or leave the page
  // visible. It is stronger evidence than blur, which can come from a picker.
  createEffect(() => {
    const session = navigator.mediaSession;
    if (
      !automatic() ||
      !engaged() ||
      !pip.supported() ||
      !session
    )
      return;
    const action =
      "enterpictureinpicture" as MediaSessionAction;
    try {
      session.setActionHandler(action, (details) => {
        const reason = (
          details as MediaSessionActionDetails & {
            enterPictureInPictureReason?: string;
          }
        )?.enterPictureInPictureReason;
        openAutomatically(
          "background",
          reason === "contentoccluded",
        );
      });
    } catch {
      return;
    }
    onCleanup(() => session.setActionHandler(action, null));
  });
  const background = () => {
    // Supplement the browser callback while a recent user gesture is still valid.
    // Without activation, wait for the browser instead of generating denied requests.
    if (
      !pageHidden() ||
      !navigator.userActivation?.isActive
    )
      return;
    openAutomatically("background");
  };
  const foreground = () => {
    if (!inForeground()) return;
    dismissed = false;
    if (
      automaticReason === "background" &&
      onMeetingPage()
    ) {
      automaticReason = undefined;
      pip.close();
    }
  };
  const visibility = () => {
    if (pageHidden()) background();
    else foreground();
  };
  document.addEventListener("visibilitychange", visibility);
  // A PiP window can make the opener visible without focusing it. Returning
  // then emits only focus; use it to close/rearm, never to open on mere blur.
  window.addEventListener("focus", foreground);
  onCleanup(() => {
    document.removeEventListener(
      "visibilitychange",
      visibility,
    );
    window.removeEventListener("focus", foreground);
  });
  createEffect(() => {
    const id = pinnedId();
    if (
      id &&
      !sources().some((source) => source.id === id)
    ) {
      setPinnedId(
        selectMeetingPipSource(sources(), null)?.id ?? null,
      );
    }
  });
  createEffect(
    on(
      state.activeRoomConversationId,
      (room, previous) => {
        if (room === previous) return;
        pip.close();
        setPinnedId(null);
        if (!room) setEngaged(false);
      },
      { defer: true },
    ),
  );
  const returnToMeeting = () => {
    window.focus();
    navigate(HOME_PATH);
    pip.close();
  };
  const leave = () => {
    setEngaged(false);
    pip.close();
    state.leaveRoom();
    navigate("/");
  };
  const controls: MeetingPipControls = {
    supported: pip.supported,
    active: pip.active,
    busy: pip.busy,
    automatic,
    setAutomatic,
    toggle: () => {
      automaticReason = undefined;
      if (pip.active()) pip.close();
      else {
        dismissed = false;
        void pip.open();
      }
    },
    returnToMeeting,
  };
  return {
    clients,
    sources,
    pinnedId,
    setPinnedId,
    railCollapsed,
    setRailCollapsed,
    toolbarCollapsed,
    setToolbarCollapsed,
    selected,
    pip,
    controls,
    leave,
  };
}

const MeetingSessionContext =
  createContext<ReturnType<typeof createMeetingSession>>();

export function useMeetingSession() {
  const session = useContext(MeetingSessionContext);
  if (!session)
    throw new Error("Meeting session context not found");
  return session;
}

/** Lives above the router's pages, so a PiP window survives leaving Home. */
export function MeetingSessionProvider(props: ParentProps) {
  const session = createMeetingSession();
  return (
    <MeetingSessionContext.Provider value={session}>
      {props.children}
      <Show when={session.pip.window()} keyed>
        {(window) => (
          <MeetingPipWindow
            window={window}
            sources={session.sources()}
            featuredId={session.selected()?.id ?? null}
            railCollapsed={session.railCollapsed()}
            onRailCollapsedChange={session.setRailCollapsed}
            toolbarCollapsed={session.toolbarCollapsed()}
            onToolbarCollapsedChange={
              session.setToolbarCollapsed
            }
            onSelect={session.setPinnedId}
            controls={session.controls}
            onLeave={session.leave}
          />
        )}
      </Show>
    </MeetingSessionContext.Provider>
  );
}
