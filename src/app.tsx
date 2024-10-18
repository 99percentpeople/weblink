import {
  RouteSectionProps,
  useSearchParams,
} from "@solidjs/router";

import {
  onCleanup,
  onMount,
  ParentProps,
  Show,
} from "solid-js";
import { Toaster } from "@/components/ui/sonner";
import ChatProvider from "./components/chat/chat-provider";
import Nav from "@/components/nav";
import { ReloadPrompt } from "./components/reload-prompt";
import {
  ColorModeProvider,
  ColorModeScript,
  createLocalStorageManager,
  useColorMode,
} from "@kobalte/core";
import {
  clientProfile,
  setClientProfile,
} from "./libs/core/store";
import { useWebRTC } from "./libs/core/rtc-context";
import {
  JoinRoomButton,
  createRoomDialog,
  joinUrl,
} from "./components/join-dialog";
import { toast } from "solid-sonner";
import { sessionService } from "./libs/services/session-service";
import { createDialog } from "./components/dialogs/dialog";
import { QRCode } from "./components/qrcode";
import { Button } from "./components/ui/button";
import { IconQRCode } from "./components/icons";
import { t } from "./i18n";
import createAboutDialog from "./components/about-dialog";
import { appOptions, setAppOptions } from "./options";

let wakeLock: WakeLockSentinel | null = null;
const requestWakeLock = async () => {
  if (wakeLock && wakeLock.released === false) {
    return;
  }
  try {
    wakeLock = await navigator.wakeLock.request("screen");
    wakeLock.addEventListener("release", () => {
      wakeLock = null;
    });
  } catch (err) {
    if (err instanceof Error)
      console.error(`${err.name}, ${err.message}`);
  }
};

const createQRCodeDialog = () => {
  const { colorMode } = useColorMode();
  const { open, Component: QRCodeDialogComponent } =
    createDialog({
      title: () => t("common.scan_qrcode_dialog.title"),
      content: () => {
        const url = joinUrl();

        const handleLongPress = () => {
          navigator.clipboard
            .writeText(url)
            .then(() => {
              toast.success(
                t("common.notification.copy_success"),
              );
            })
            .catch(() => {
              toast.error(
                t("common.notification.copy_failed"),
              );
            });
        };

        return (
          <div class="flex select-none flex-col items-center">
            <div
              onContextMenu={(e) => {
                e.preventDefault();
                handleLongPress();
              }}
            >
              <QRCode
                value={url}
                dark={
                  colorMode() === "dark"
                    ? "#ffffff"
                    : "#000000"
                }
                light="#00000000"
              />
            </div>
            <p>
              {t("common.scan_qrcode_dialog.description")}
            </p>
            <p class="mt-2 text-sm text-muted-foreground">
              {t("common.scan_qrcode_dialog.tip")}
            </p>
          </div>
        );
      },
    });
  return { open, Component: QRCodeDialogComponent };
};

const InnerApp = (props: ParentProps) => {
  const { joinRoom } = useWebRTC();
  const [search, setSearch] = useSearchParams();

  const {
    open: openRoomDialog,
    Component: RoomDialogComponent,
  } = createRoomDialog();

  const {
    open: openQRCodeDialog,
    Component: QRCodeDialogComponent,
  } = createQRCodeDialog();

  const {
    open: openAboutDialog,
    Component: AboutDialogComponent,
  } = createAboutDialog();

  const onJoinRoom = async () => {
    if (clientProfile.firstTime) {
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

  onMount(async () => {
    let reset = false;
    if (search.id && search.id !== clientProfile.roomId) {
      setClientProfile("roomId", search.id);
      setSearch({ id: null }, { replace: true });
      reset = true;
    }
    if (
      search.pwd &&
      search.pwd !== clientProfile.password
    ) {
      setClientProfile("password", search.pwd);
      setSearch({ pwd: null }, { replace: true });
      reset = true;
    }
    if (reset) {
      setClientProfile("firstTime", true);
    }

    if (search.join) {
      onJoinRoom();
      return;
    }

    if (
      !sessionService.clientService &&
      clientProfile.autoJoin
    ) {
      await onJoinRoom();
    }
  });

  onMount(async () => {
    requestWakeLock();

    document.addEventListener(
      "visibilitychange",
      async () => {
        if (document.visibilityState === "visible") {
          await requestWakeLock();
        }
      },
    );
  });

  onMount(() => {
    if (appOptions.showAboutDialog) {
      openAboutDialog();
    }
  });

  onCleanup(() => {
    wakeLock?.release();
  });
  return (
    <>
      <RoomDialogComponent />
      <QRCodeDialogComponent />
      <AboutDialogComponent />
      <div
        class="sticky top-0 z-50 flex h-12 w-full flex-wrap items-center
          gap-4 border-b border-border bg-background/80 px-2
          backdrop-blur"
      >
        <h2 class="hidden font-mono text-xl font-bold sm:block">
          Weblink
        </h2>
        <Nav />
        <div class="ml-auto"></div>
        <Show
          when={
            sessionService.clientServiceStatus() ===
            "connected"
          }
        >
          <Button onClick={openQRCodeDialog} size="icon">
            <IconQRCode class="size-6" />
          </Button>
        </Show>
        <JoinRoomButton />
      </div>
      <ReloadPrompt />

      {props.children}
    </>
  );
};

export default function App(props: RouteSectionProps) {
  const storageManager =
    createLocalStorageManager("ui-theme");

  return (
    <>
      <Toaster />
      <ColorModeScript storageType={storageManager.type} />
      <ColorModeProvider storageManager={storageManager}>
        <ChatProvider>
          <InnerApp> {props.children}</InnerApp>
        </ChatProvider>
      </ColorModeProvider>
    </>
  );
}
