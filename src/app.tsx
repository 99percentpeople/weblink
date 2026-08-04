import {
  RouteSectionProps,
  useSearchParams,
} from "@solidjs/router";
import {
  createEffect,
  ErrorBoundary,
  onCleanup,
  onMount,
  ParentProps,
  Show,
} from "solid-js";
import { Toaster } from "@/components/ui/sonner";
import Nav from "@/components/app/nav";
import {
  getRandomAvatar,
  setClientProfile,
} from "./libs/core/store";
import {
  AppStateProvider,
  useAppState,
} from "@/libs/state/app-state-context";
import {
  JoinRoomButton,
  createRoomDialog,
  joinUrl,
} from "./components/dialogs/join-dialog";
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
  TurnServerOptions,
} from "./options";
import { MetaProvider, Style } from "@solidjs/meta";
import { produce } from "solid-js/store";
import { createQRCodeDialog } from "./components/dialogs/create-qrcode-dialog";
import { createForwardDialog } from "./components/dialogs/forward-dialog";
import { createReloadPrompt } from "./libs/hooks/reload-prompt";
import { catchError } from "./libs/catch";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "./components/ui/avatar";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "./components/ui/hover-card";
import {
  IconContentCopy,
  IconHome,
  IconLink,
  IconPermContactCalendar,
  IconResetWrench,
} from "./components/icons";
import { getInitials } from "./libs/utils/name";
import { Button } from "./components/ui/button";
import { t, isDictLoaded } from "./i18n";
import { v4 } from "uuid";
import { createIsMobile } from "./libs/hooks/create-mobile";
import { messageStores } from "./libs/core/message";
import { sleep } from "./libs/utils/sleep";
import { Label } from "./components/ui/label";
import { Textarea } from "./components/ui/textarea";
import { AudioPlayerProvider } from "./routes/video/components/audio-player";
import { AppWakeLock } from "./components/app/wakelock";
import { createInitialization } from "@/libs/initialization";
import { appState } from "@/libs/state/app-state";
import { localStream } from "@/libs/services/local-stream-service";
import { ModalProvider } from "@/components/dialogs/base";

const InnerApp = (props: ParentProps) => {
  const { joinRoom } = useAppState();
  const [search, setSearch] = useSearchParams();

  const { open: openRoomDialog } = createRoomDialog();

  const { open: openQRCodeDialog } = createQRCodeDialog();

  const { open: openAboutDialog } = createAboutDialog();

  const onJoinRoom = async () => {
    if (appState.profile.initalJoin) {
      const result = await openRoomDialog();
      if (result.cancel) {
        return;
      }
    }

    await joinRoom().catch((err) => {
      console.error(err);
      toast.error(err.message);
    });
  };

  const parseSearchParams = async () => {
    let reset = false;
    if (
      search.id &&
      search.id !== appState.profile.roomId
    ) {
      setClientProfile("roomId", search.id as string);
      setSearch({ id: null }, { replace: true });
      reset = true;
    }
    if (
      search.pwd &&
      search.pwd !== appState.profile.password
    ) {
      setClientProfile("password", search.pwd as string);
      setSearch({ pwd: null }, { replace: true });
      reset = true;
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
      const turnServers = JSON.parse(
        search.turn as string,
      ) as TurnServerOptions[];

      if (!appState.options.servers.turns) {
        setAppOptions("servers", "turns", []);
      }

      setAppOptions(
        "servers",
        "turns",
        produce((state) => {
          turnServers.forEach((server) => {
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
    if (reset) {
      setClientProfile("initalJoin", true);
    }

    if (search.join) {
      onJoinRoom();
      return;
    }

    if (
      appState.session.clientServiceStatus ===
        "disconnected" &&
      appState.profile.autoJoin
    ) {
      await onJoinRoom();
    }
  };

  const initStarterMessage = async () => {
    const instructorClientId = v4();
    const instructorName = t("common.starter.starter_name");
    messageStores.setClient({
      clientId: instructorClientId,
      name: instructorName,
      avatar: getRandomAvatar(instructorName),
    });

    await messageStores.addMessage({
      id: v4(),
      type: "text",
      client: instructorClientId,
      target: appState.profile.clientId,
      data: t("common.starter.welcome"),
      createdAt: Date.now(),
      status: "received",
    });
    await sleep(1);
    await messageStores.addMessage({
      id: v4(),
      type: "text",
      client: instructorClientId,
      target: appState.profile.clientId,
      data: t("common.starter.tip1"),
      createdAt: Date.now(),
      status: "received",
    });
    await sleep(1);
    await messageStores.addMessage({
      id: v4(),
      type: "text",
      client: instructorClientId,
      target: appState.profile.clientId,
      data: t("common.starter.tip2"),
      createdAt: Date.now(),
      status: "received",
    });
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

  createEffect(() => {
    if (isDictLoaded() && !starterMessageSent()) {
      setStarterMessageSent(true);
      initStarterMessage();
    }
  });

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
  const isMobile = createIsMobile();

  return (
    <>
      <AppWakeLock enabled={appState.options.wakeLock} />

      <div class="flex h-full min-h-full w-full flex-col md:flex-row">
        <div
          class="border-border bg-background/80 scrollbar-none sticky top-0
            z-50 h-[var(--mobile-header-height)] max-h-[100vh]
            w-[var(--desktop-header-width)] flex-shrink-0
            overflow-y-auto border-b backdrop-blur md:border-r
            md:border-b-0"
        >
          <div
            class="sticky top-0 flex h-full max-h-[100vh] items-center gap-2
              px-2 py-0 md:flex-col md:px-0 md:py-2"
          >
            <Nav class="items-center gap-2 p-2 md:flex-col md:gap-4" />
            <div class="flex-1"></div>
            <HoverCard
              gutter={6}
              placement={
                isMobile() ? "bottom" : "right-end"
              }
            >
              <HoverCardTrigger
                as={Avatar}
                class="size-8 hover:cursor-pointer md:mt-auto md:size-10"
                onTouchStart={() => {
                  if (isMobile()) {
                    openQRCodeDialog();
                  }
                }}
              >
                <AvatarImage
                  src={appState.profile.avatar ?? undefined}
                />
                <AvatarFallback>
                  {getInitials(appState.profile.name)}
                </AvatarFallback>
              </HoverCardTrigger>
              <HoverCardContent class="flex flex-col gap-2">
                <div class="flex gap-4">
                  <Avatar class="size-12">
                    <AvatarImage
                      src={
                        appState.profile.avatar ?? undefined
                      }
                    />
                    <AvatarFallback>
                      {getInitials(appState.profile.name)}
                    </AvatarFallback>
                  </Avatar>
                  <div class="flex flex-col gap-2">
                    <p class="text-sm font-medium">
                      {appState.profile.name}
                    </p>
                    <Show when={appState.roomStatus.roomId}>
                      {(room) => (
                        <p class="text-muted-foreground flex items-center gap-1 text-xs">
                          <IconHome class="size-4" />{" "}
                          {room()}
                        </p>
                      )}
                    </Show>
                    <Show
                      when={appState.roomStatus.profile}
                    >
                      {(profile) => (
                        <p class="text-muted-foreground flex items-center gap-1 text-xs">
                          <IconPermContactCalendar class="size-4" />
                          {new Date(
                            profile().createdAt,
                          ).toLocaleString()}
                        </p>
                      )}
                    </Show>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  class="gap-2"
                  onClick={async () => {
                    const [err] = await catchError(
                      navigator.clipboard.writeText(
                        joinUrl(),
                      ),
                    );
                    if (err) {
                      toast.error(
                        t(
                          "common.notification.link_copy_failed",
                        ),
                      );
                    } else {
                      toast.success(
                        t(
                          "common.notification.link_copy_success",
                        ),
                      );
                    }
                  }}
                >
                  <IconLink class="size-4" />

                  {t("common.nav.share_link")}
                </Button>
              </HoverCardContent>
            </HoverCard>
            <JoinRoomButton class="md:hidden" />
          </div>
        </div>
        <div class="flex-1">
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

  return (
    <>
      <MetaProvider>
        <Style>
          {`
          :root {
            --background-image: url(${backgroundImage() ?? ""});
            --background-image-opacity: ${appState.options.backgroundImageOpacity};
          }`}
        </Style>
        <Toaster />
        <AppStateProvider localStream={localStream()}>
          <ModalProvider>
            <AudioPlayerProvider>
              <InnerApp>{props.children}</InnerApp>
            </AudioPlayerProvider>
          </ModalProvider>
        </AppStateProvider>
      </MetaProvider>
    </>
  );
}
