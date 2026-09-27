import { sanitizeTurnServers } from "@/libs/domain/ice-server";
import {
  RouteSectionProps,
  useSearchParams,
  useLocation,
  A,
} from "@solidjs/router";
import {
  createEffect,
  createMemo,
  on,
  ErrorBoundary,
  onCleanup,
  onMount,
  ParentProps,
  Show,
} from "solid-js";
import { Toaster } from "@/components/ui/sonner";
import { AccountMenu } from "@/components/app/account-menu";
import { RoomConnectionOverlay } from "@/components/app/room-connection-overlay";
import {
  AppDialogsProvider,
  useAppDialogs,
} from "@/components/app/app-dialogs";
import {
  RoomActionsProvider,
  useRoomActions,
} from "@/components/app/room-actions";
import { isHomePath } from "@/libs/application/home-navigation";
import { resolveWallpaper } from "@/libs/wallpapers";
import { setClientProfile } from "./libs/state/profile-store";
import { optional } from "./libs/domain/utils/optional";
import {
  AppStateProvider,
  useAppState,
} from "@/libs/state/app-state-context";

import { toast } from "solid-sonner";
import createAboutDialog from "./components/dialogs/about-dialog";
import {
  appInitialized,
  backgroundImage,
  localeOptionsMap,
  localFromLanguage,
  setAppInitialized,
  setAppOptions,
  setStarterMessageSent,
  starterMessageSent,
} from "./options";
import { MetaProvider, Style } from "@solidjs/meta";
import { produce } from "solid-js/store";

import { createForwardDialog } from "./components/dialogs/forward-dialog";
import { createReloadPrompt } from "./libs/hooks/reload-prompt";

import {
  IconContentCopy,
  IconHome,
  IconResetWrench,
} from "./components/icons";

import { Button } from "./components/ui/button";
import { t, isDictLoaded } from "./i18n";

import { Label } from "./components/ui/label";
import { Textarea } from "./components/ui/textarea";
import { AudioPlayerProvider } from "./routes/home/components/audio-player";
import { AppWakeLock } from "./components/app/wakelock";
import { createInitialization } from "@/libs/application/initialization";
import { appState } from "@/libs/state/app-state";
import { createLocalStreamService } from "@/libs/application/local-stream-service";
import { MeetingMediaProvider } from "@/libs/hooks/meeting-media-context";
import { ModalProvider } from "@/components/dialogs/base";
import { MeetingSessionProvider } from "@/routes/home/components/meeting-session-context";

const InnerApp = (props: ParentProps) => {
  const { conversationHistory } = useAppState();
  const roomActions = useRoomActions();
  const dialogs = useAppDialogs();
  const route = useLocation();
  const [search, setSearch] = useSearchParams();

  const { open: openAboutDialog } = createAboutDialog();
  const onJoinRoom = roomActions.join;
  createEffect(
    on(
      () => search.dialog,
      (dialog) => {
        if (dialog !== "settings" && dialog !== "files")
          return;
        setSearch({ dialog: undefined }, { replace: true });
        if (dialog === "settings")
          void dialogs.openSettings();
        else void dialogs.openFiles();
      },
    ),
  );

  const parseSearchParams = async () => {
    const hasRoomIdParam = search.id !== undefined;
    const hasPasswordParam = search.pwd !== undefined;

    if (
      hasRoomIdParam &&
      search.id !== appState.profile.roomId
    ) {
      setClientProfile("roomId", search.id as string);
    }
    if (
      hasPasswordParam &&
      search.pwd !== appState.profile.password
    ) {
      setClientProfile(
        "password",
        optional(search.pwd as string),
      );
    }

    if (hasRoomIdParam || hasPasswordParam) {
      setSearch(
        {
          id: null,
          pwd: null,
        },
        { replace: true },
      );
    }

    if (search.stun) {
      const stunServers = JSON.parse(
        search.stun as string,
      ) as string[];
      setAppOptions(
        "servers",
        "stuns",
        produce((state) => {
          stunServers.forEach((server) => {
            if (!state.includes(server)) {
              state.push(server);
            }
          });
        }),
      );
    }
    if (search.turn) {
      const turnServers = JSON.parse(search.turn as string);
      const supportedTurnServers =
        sanitizeTurnServers(turnServers);

      if (!appState.options.servers.turns) {
        setAppOptions("servers", "turns", []);
      }

      setAppOptions(
        "servers",
        "turns",
        produce((state) => {
          supportedTurnServers.forEach((server) => {
            if (
              state?.findIndex(
                (s) => s.url === server.url,
              ) === -1
            ) {
              state.push(server);
            }
          });
        }),
      );
    }
    if (
      appState.session.clientServiceStatus ===
        "disconnected" &&
      appState.profile.autoJoin
    ) {
      await onJoinRoom();
    }
  };

  onMount(async () => {
    parseSearchParams();
    if (!localeOptionsMap[appState.options.locale]) {
      setAppOptions(
        "locale",
        localFromLanguage(navigator.language),
      );
    }

    if (!appInitialized()) {
      setAppInitialized(true);
      openAboutDialog();
    }
  });

  let creatingGuide = false;
  createEffect(
    on(
      () => isDictLoaded() && !starterMessageSent(),
      (ready) => {
        if (!ready || creatingGuide) return;
        creatingGuide = true;
        void conversationHistory
          .cacheLocalTextBatch(
            "welcome",
            "weblink:welcome",
            t("common.starter.starter_name"),
            [
              "welcome",
              "connect",
              "chat",
              "files",
              "meeting",
              "settings",
            ].map((key) => ({
              key,
              text: t(`common.starter.${key}`),
            })),
          )
          .then(() => setStarterMessageSent(true))
          .catch((error) => {
            console.error(
              "[Welcome] could not save the guide",
              error,
            );
            toast.error(
              error instanceof Error
                ? error.message
                : String(error),
            );
          })
          .finally(() => {
            creatingGuide = false;
          });
      },
    ),
  );

  createReloadPrompt();

  const { forwardTarget: shareTarget } =
    createForwardDialog();

  if (navigator.serviceWorker) {
    onMount(() => {
      const onMessage = (ev: MessageEvent) => {
        if (ev.data.action === "share-target") {
          window.focus();
          shareTarget(ev.data.data as ShareData);
        }
      };
      navigator.serviceWorker.addEventListener(
        "message",
        onMessage,
      );
      onCleanup(() => {
        navigator.serviceWorker.removeEventListener(
          "message",
          onMessage,
        );
      });
    });
  }
  return (
    <>
      <AppWakeLock enabled={appState.options.wakeLock} />
      <RoomConnectionOverlay />
      <div class="app-shell">
        <Show when={!isHomePath(route.pathname)}>
          <header class="app-page-header">
            <Button as={A} href="/" variant="ghost">
              <IconHome />
              {t("404.home")}
            </Button>
            <AccountMenu />
          </header>
        </Show>
        <div class="app-page-content">
          <ErrorBoundary
            fallback={(err: Error, reset) => (
              <ErrorComponent error={err} reset={reset} />
            )}
          >
            {props.children}
          </ErrorBoundary>
        </div>
      </div>
    </>
  );
};

const ErrorComponent = (props: {
  error: Error;
  reset: () => void;
}) => {
  return (
    <div
      class="bg-background/80 flex size-full max-w-[100vw] flex-col
        justify-center gap-2 px-2 py-4 backdrop-blur"
    >
      <h3 class="h3 mb-4">
        {t("common.error_boundary.title")}
      </h3>
      <Label>
        {t("common.error_boundary.description")}
      </Label>
      <div class="flex h-full flex-col gap-2">
        <p>{props.error.message}</p>
        {/* Print stack trace */}
        <Textarea
          readOnly
          class="scrollbar-thin flex-1 overflow-x-auto text-xs text-nowrap
            whitespace-pre-wrap"
          value={props.error.stack}
        />
      </div>
      <div class="flex gap-2 self-end">
        <Show
          when={
            "clipboard" in navigator && props.error.stack
          }
        >
          {(stack) => (
            <Button
              class="gap-2"
              onClick={() =>
                navigator.clipboard
                  .writeText(stack())
                  .then(() => {
                    toast.success(
                      t("common.notification.copy_success"),
                    );
                  })
              }
              variant="outline"
            >
              <IconContentCopy class="size-4" />
              {t("common.action.copy")}
            </Button>
          )}
        </Show>
        <Button
          variant="outline"
          onClick={() => {
            props.reset();
            location.reload();
          }}
          class="gap-2"
        >
          <IconResetWrench class="size-4" />
          {t("common.error_boundary.reset")}
        </Button>
      </div>
    </div>
  );
};

export default function App(props: RouteSectionProps) {
  const localStreamService = createLocalStreamService();
  onCleanup(() => localStreamService.dispose());
  if (window.location.pathname === "/close-window") {
    try {
      window.close();
    } catch (e) {
      console.warn(e);
    }
    window.location.replace("about:blank");
    return <></>;
  }

  void createInitialization().catch((err) => {
    console.error(err);
    toast.error(err?.message ?? String(err));
  });

  const wallpaper = createMemo(() =>
    resolveWallpaper(
      appState.options.backgroundPreset,
      backgroundImage(),
    ),
  );

  return (
    <>
      <MetaProvider>
        <Style>
          {`
          :root {
            --background-image: ${wallpaper().image};
            --background-image-size: ${wallpaper().size};
            --background-image-repeat: ${wallpaper().repeat};
            --background-image-opacity: ${appState.options.backgroundImageOpacity};
          }`}
        </Style>
        <Toaster />
        <AppStateProvider
          localStreamService={localStreamService}
        >
          <AudioPlayerProvider>
            <MeetingMediaProvider>
              <RoomActionsProvider>
                <MeetingSessionProvider>
                  <AppDialogsProvider>
                    <ModalProvider>
                      <InnerApp>{props.children}</InnerApp>
                    </ModalProvider>
                  </AppDialogsProvider>
                </MeetingSessionProvider>
              </RoomActionsProvider>
            </MeetingMediaProvider>
          </AudioPlayerProvider>
        </AppStateProvider>
      </MetaProvider>
    </>
  );
}
