import {
  RouteSectionProps,
  useLocation,
  useSearchParams,
} from "@solidjs/router";

import {
  createEffect,
  lazy,
  onCleanup,
  onMount,
  ParentProps,
} from "solid-js";

import ChatProvider from "./components/chat/chat-provider";
import Nav from "@/components/nav";
import { ReloadPrompt } from "./components/reload-prompt";
import {
  ColorModeProvider,
  ColorModeScript,
  createLocalStorageManager,
} from "@kobalte/core";
import {
  clientProfile,
  setClientProfile,
} from "./libs/core/store";
import { useWebRTC } from "./libs/core/rtc-context";
import { createRoomDialog } from "./components/join-dialog";

const JoinRoom = lazy(
  () => import("./components/join-dialog"),
);

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

const InnerApp = (props: ParentProps) => {
  const { joinRoom } = useWebRTC();
  const [search, setSearch] = useSearchParams();

  createEffect(async () => {
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
      if (clientProfile.firstTime) {
        const result = await open();
        if (!result.cancel) {
          joinRoom();
        }
      } else {
        joinRoom();
      }
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

  const { open, Component } = createRoomDialog();

  onCleanup(() => {
    wakeLock?.release();
  });
  return (
    <>
      <Component />
      <div
        class="sticky top-0 z-50 flex h-12 w-full flex-wrap items-center
          gap-4 border-b border-border bg-background/80 px-2
          backdrop-blur"
      >
        <h2 class="font-mono text-xl font-bold">Weblink</h2>
        <Nav />
        <div class="ml-auto">
          <JoinRoom />
        </div>
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
      <ColorModeScript storageType={storageManager.type} />
      <ColorModeProvider storageManager={storageManager}>
        <ChatProvider>
          <InnerApp> {props.children}</InnerApp>
        </ChatProvider>
      </ColorModeProvider>
    </>
  );
}