import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  untrack,
} from "solid-js";
import { useBeforeLeave } from "@solidjs/router";
import {
  HOME_PATH,
  isHomePath,
} from "@/libs/application/home-navigation";
import { appState } from "@/libs/state/app-state";
import { platform } from "@/libs/platform/runtime";
import { setAppOptions } from "@/options";
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import type { MeetingMediaContextValue } from "@/libs/state/meeting-media-context";
import { createReducedMotion } from "@/libs/hooks/reduced-motion";
import {
  createDocumentPictureInPicture,
  type DocumentPictureInPictureAPI,
} from "@/libs/hooks/document-picture-in-picture";
import { t } from "@/i18n";
import { toast } from "solid-sonner";
import { sessionService } from "@/libs/application/session-service";
import { createNativePictureInPicture } from "@/libs/application/native-picture-in-picture";
import { createMeetingMainView } from "@/routes/home/components/meeting-main-view";
import {
  createMeetingSources,
  selectMeetingFeaturedSource,
  selectMeetingVideoSource,
} from "@/routes/home/components/meeting-sources";
import { reportMeetingPipError } from "@/routes/home/components/meeting-pip-error";
import type { MeetingPipControls } from "@/routes/home/components/meeting-controls";

import type { Location, Navigator } from "@solidjs/router";
export function createMeetingSession({
  state,
  media: { media },
  location,
  navigate,
  confirmation,
}: {
  state: AppStateContextProps;
  media: MeetingMediaContextValue;
  location: Location;
  navigate: Navigator;
  confirmation: {
    confirm(mount?: HTMLElement): Promise<boolean>;
    dismiss(): void;
  };
}) {
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
  const automatic = () =>
    appState.options.application.automaticPictureInPicture;
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
      nativeScreenStream: client.nativeScreenStream,
      videoSources: client.videoSources,
      videoTracks: client.videoTracks,
      audioSources: client.audioSources,
      audioTracks: client.audioTracks,
      placeholder: client.streamState === "placeholder",
    })),
  ]);
  const selected = createMemo(() =>
    selectMeetingFeaturedSource(sources(), pinnedId()),
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
  const browserPip = createDocumentPictureInPicture({
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
  const [nativeActive, setNativeActive] =
    createSignal(false);
  const [nativeBusy, setNativeBusy] = createSignal(0);
  const [nativeTransitioning, setNativeTransitioning] =
    createSignal(false);
  const [nativeTitleBarHeight, setNativeTitleBarHeight] =
    createSignal(36);
  const reducedMotion = createReducedMotion();
  const nativePip = platform.pictureInPicture
    ? createNativePictureInPicture(
        platform.pictureInPicture,
        (state) => {
          setNativeTitleBarHeight(state.titleBarHeight);
          setNativeActive(state.active);
          setNativeTransitioning(state.transitioning);
        },
        reportMeetingPipError,
      )
    : undefined;
  const runNative = async (action: () => Promise<void>) => {
    setNativeBusy((value) => value + 1);
    try {
      await action();
    } finally {
      setNativeBusy((value) => value - 1);
    }
  };
  const pip = nativePip
    ? {
        window: browserPip.window,
        supported: () => true,
        active: nativeActive,
        busy: () =>
          nativeBusy() > 0 || nativeTransitioning(),
        open: () => runNative(nativePip.enter),
        close: () => runNative(nativePip.exit),
      }
    : browserPip;
  const [nativeAutoBlocked, setNativeAutoBlocked] =
    createSignal(false);
  if (nativePip) {
    const blur = () =>
      setNativeAutoBlocked(
        Boolean(
          document.querySelector(
            'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
          ),
        ),
      );
    const focus = () => setNativeAutoBlocked(false);
    window.addEventListener("blur", blur);
    window.addEventListener("focus", focus);
    onCleanup(() => {
      window.removeEventListener("blur", blur);
      window.removeEventListener("focus", focus);
    });
  }
  // Keep native eligibility current without moving/recreating the meeting tree.
  createEffect(() => {
    if (!nativePip) return;
    const source = selected();
    nativePip.configure({
      reducedMotion: reducedMotion(),
      eligible:
        !!source &&
        onMeetingPage() &&
        engaged() &&
        !state.roomConflict(),
      automatic:
        automatic() &&
        hasSharedVideo() &&
        !media.sharingBusy() &&
        !nativeAutoBlocked(),
    });
  });
  onCleanup(() => {
    void nativePip?.close();
  });
  const mainView = createMeetingMainView({
    current: () => selected()?.id,
    valid: (id) =>
      !id || sources().some((source) => source.id === id),
    confirm: () =>
      confirmation.confirm(
        (document.fullscreenElement as HTMLElement | null) ??
          pip.window()?.document.body,
      ),
    shared: {
      active: () => pip.active() || pip.busy(),
      stop: async () => {
        automaticReason = undefined;
        await pip.close();
        return !pip.active();
      },
    },
    onError: () =>
      toast.error(t("meeting.leave_main_failed")),
  });
  const changePinnedId = (
    id: string | null,
    transition: (update: () => void) => void = (update) =>
      update(),
    activate?: () => void,
  ) => {
    if (id && !sources().some((source) => source.id === id))
      return;
    const next = selectMeetingFeaturedSource(
      sources(),
      id,
    )?.id;
    void mainView.change(next, () => {
      transition(() => setPinnedId(id));
      // The guard's immediate path preserves the original click activation.
      activate?.();
    });
  };
  onCleanup(() => mainView.invalidate());
  const openAutomatically = (
    reason: "route" | "background",
    browserOccluded = false,
  ) => {
    if (
      nativePip ||
      !automatic() ||
      state.roomConflict() ||
      !engaged() ||
      !hasSharedVideo() ||
      !selected() ||
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
      nativePip ||
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
    if (nativePip || !inForeground()) return;
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
  let hadSharedScreen = false;
  createEffect(
    on(sources, (next, previous) => {
      const former = selectMeetingFeaturedSource(
        previous ?? [],
        pinnedId(),
      );
      const firstScreen = next.find(
        (source) => source.kind === "screen",
      );
      const appeared = !hadSharedScreen && !!firstScreen;
      hadSharedScreen = !!firstScreen;
      if (
        former &&
        !next.some((source) => source.id === former.id)
      ) {
        mainView.remove(former.id);
        confirmation.dismiss();
        pip.close();
      }
      // Preserve an implicit single main tile when another source joins. New
      // shares must not replace a view that owns control, fullscreen or PiP.
      if (
        former &&
        next.some((source) => source.id === former.id) &&
        mainView.active(former.id)
      ) {
        setPinnedId(former.id);
        return;
      }
      if (appeared && firstScreen) {
        setPinnedId(firstScreen.id);
        return;
      }
      const id = pinnedId();
      if (id && !next.some((source) => source.id === id)) {
        setPinnedId(
          selectMeetingVideoSource(next)?.id ?? null,
        );
      }
    }),
  );
  createEffect(
    on(
      () => selected()?.id,
      () => confirmation.dismiss(),
      { defer: true },
    ),
  );
  // An avatar request continues on its approved screen. This is the same
  // control session, not an unrelated source stealing the user's main view.
  createEffect(() => {
    const main = selected();
    const next = sources();
    if (!main || main.local || main.kind === "screen")
      return;
    const request = sessionService.getScreenControl(
      main.participantId,
    );
    if (!request) return;
    const follow = () => {
      if (untrack(selected)?.id !== main.id) return;
      const screen = next.find(
        (source) =>
          source.kind === "screen" &&
          source.track &&
          source.participantId === main.participantId &&
          request.controls(
            sessionService.getRemoteControl(source.track),
          ),
      );
      if (screen) setPinnedId(screen.id);
    };
    request.addEventListener("change", follow);
    untrack(follow);
    onCleanup(() =>
      request.removeEventListener("change", follow),
    );
  });
  createEffect(
    on(
      state.activeRoomConversationId,
      (room, previous) => {
        if (room === previous) return;
        mainView.invalidate();
        confirmation.dismiss();
        automaticReason = undefined;
        pip.close();
        setPinnedId(null);
        if (!room) setEngaged(false);
        else if (onMeetingPage() && !state.roomConflict()) {
          // Rejoining on Home does not trigger the route-entry effect.
          setEngaged(true);
          dismissed = false;
        }
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
    if (!onMeetingPage()) navigate(HOME_PATH);
  };
  const controls: MeetingPipControls = {
    supported: () => pip.supported() && !!selected(),
    active: pip.active,
    busy: pip.busy,
    automatic,
    setAutomatic: (value) =>
      setAppOptions(
        "application",
        "automaticPictureInPicture",
        value,
      ),
    toggle: () => {
      automaticReason = undefined;
      if (pip.active()) pip.close();
      else if (selected() && !state.roomConflict()) {
        // An explicit request also resumes the local preview after leaving a room.
        setEngaged(true);
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
    setPinnedId: changePinnedId,
    mainView,
    railCollapsed,
    setRailCollapsed,
    toolbarCollapsed,
    setToolbarCollapsed,
    selected,
    pip,
    nativePip: nativePip
      ? {
          active: nativeActive,
          transitioning: nativeTransitioning,
          titleBarHeight: nativeTitleBarHeight,
          drag: nativePip.drag,
        }
      : undefined,
    controls,
    leave,
  };
}
