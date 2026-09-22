import {
  For,
  createMemo,
  createEffect,
  Show,
  createSignal,
  ComponentProps,
  onCleanup,
} from "solid-js";
import {
  RouteSectionProps,
  useCurrentMatches,
  useNavigate,
} from "@solidjs/router";
import {
  Resizable,
  ResizableHandle,
  ResizablePanel,
} from "@/components/ui/resizable";
import type { ClientID } from "@/libs/domain/ids";
import type { ClientInfo } from "@/libs/state/app-state";
import { createIsMobile } from "@/libs/hooks/create-mobile";
import { makePersisted } from "@solid-primitives/storage";
import { IconPerson } from "@/components/icons";
import { t } from "@/i18n";
import { cn } from "@/libs/cn";
import { UserItem } from "./components/client-list-item";
import { appState } from "@/libs/state/app-state";

export interface UserItemProps extends ComponentProps<"li"> {
  client: ClientInfo;
  collapsed: boolean;
}

const DEFAULT_SIDEBAR_WIDTH = 280;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 480;
const MIN_CONTENT_WIDTH = 320;

const clamp = (
  value: number,
  minimum: number,
  maximum: number,
) => Math.max(minimum, Math.min(value, maximum));

export default function Home(props: RouteSectionProps) {
  const isMobile = createIsMobile();
  const navigate = useNavigate();
  const matches = useCurrentMatches();
  const [sidebarWidth, setSidebarWidth] = makePersisted(
    createSignal(DEFAULT_SIDEBAR_WIDTH),
    {
      storage: sessionStorage,
      name: "sidebar-width",
    },
  );
  const [resizableWidth, setResizableWidth] =
    createSignal(0);
  let resizeObserver: ResizeObserver | undefined;
  let resizingSidebar = false;
  let lastExpandedSidebarWidth =
    sidebarWidth() > 0
      ? sidebarWidth()
      : DEFAULT_SIDEBAR_WIDTH;

  const path = createMemo<string | undefined>(() => {
    return matches()[matches().length - 1]?.path;
  });

  const maximumSidebarWidth = () =>
    Math.max(
      0,
      Math.min(
        MAX_SIDEBAR_WIDTH,
        resizableWidth() - MIN_CONTENT_WIDTH,
      ),
    );

  const currentSidebarWidth = () => {
    const width = sidebarWidth();
    if (width <= 0) return 0;

    const maximum = maximumSidebarWidth();
    const minimum = Math.min(MIN_SIDEBAR_WIDTH, maximum);
    return clamp(width, minimum, maximum);
  };

  const sizes = createMemo<number[] | undefined>(() => {
    if (isMobile()) return [1];

    const width = resizableWidth();
    if (width <= 0) return undefined;

    const panelWidth = currentSidebarWidth();
    const ratio = clamp(panelWidth / width, 0, 1);
    return [ratio, 1 - ratio];
  });

  const setResizableRef = (element: HTMLDivElement) => {
    resizeObserver?.disconnect();

    const updateWidth = (width: number) => {
      if (Number.isFinite(width) && width > 0) {
        setResizableWidth(width);
      }
    };

    updateWidth(element.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;

    resizeObserver = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect) updateWidth(rect.width);
    });
    resizeObserver.observe(element);
  };

  const resizeSidebar = (nextSizes: number[]) => {
    if (
      isMobile() ||
      !resizingSidebar ||
      nextSizes.length !== 2
    ) {
      return;
    }

    const width = resizableWidth();
    if (width <= 0) return;

    const nextWidth = nextSizes[0]! * width;
    if (nextWidth <= 1) {
      setSidebarWidth(0);
      return;
    }

    if (nextWidth < MIN_SIDEBAR_WIDTH - 1) return;

    const maximum = maximumSidebarWidth();
    const minimum = Math.min(MIN_SIDEBAR_WIDTH, maximum);
    const clampedWidth = clamp(nextWidth, minimum, maximum);

    lastExpandedSidebarWidth = clampedWidth;
    setSidebarWidth(clampedWidth);
  };

  const expandSidebar = () => {
    const maximum = maximumSidebarWidth();
    const minimum = Math.min(MIN_SIDEBAR_WIDTH, maximum);
    const width = clamp(
      lastExpandedSidebarWidth || DEFAULT_SIDEBAR_WIDTH,
      minimum,
      maximum,
    );
    lastExpandedSidebarWidth = width;
    setSidebarWidth(width);
  };

  onCleanup(() => resizeObserver?.disconnect());

  createEffect(() => {
    const clientId = appState.options.redirectToClient;
    if (!clientId) return;

    const clientInfo =
      appState.session.clientViewData[clientId];
    if (clientInfo) {
      navigate(`/client/${clientId}/chat`, {
        replace: true,
      });
    }
  });

  return (
    <Resizable
      ref={setResizableRef}
      sizes={sizes()}
      onSizesChange={resizeSidebar}
      keyboardDelta="16px"
    >
      <Show when={!isMobile() || path() === "/"}>
        <ResizablePanel
          class={cn(
            `bg-background/80 backdrop-blur
            data-[collapsed]:transition-all data-[collapsed]:ease-in-out`,
          )}
          collapsible={!isMobile()}
          initialSize={
            isMobile() ? 1 : `${DEFAULT_SIDEBAR_WIDTH}px`
          }
          maxSize={
            isMobile() ? 1 : `${MAX_SIDEBAR_WIDTH}px`
          }
          minSize={
            isMobile() ? 1 : `${MIN_SIDEBAR_WIDTH}px`
          }
        >
          {(props) => (
            <ClientList
              collapsed={props.collapsed}
              expand={() => {
                if (isMobile()) {
                  props.expand();
                  return;
                }
                expandSidebar();
              }}
              path={path() ?? ""}
            />
          )}
        </ResizablePanel>
      </Show>
      <Show when={!isMobile()}>
        <ResizableHandle
          onHandleDragStart={() => {
            resizingSidebar = true;
          }}
          onHandleDragEnd={() => {
            resizingSidebar = false;
          }}
          onKeyDown={() => {
            resizingSidebar = true;
          }}
          onKeyUp={() => {
            resizingSidebar = false;
          }}
          onBlur={() => {
            resizingSidebar = false;
          }}
        />
      </Show>

      <Show when={!isMobile() || path() !== "/"}>
        <ResizablePanel
          class="relative"
          minSize={
            isMobile() ? 1 : `${MIN_CONTENT_WIDTH}px`
          }
        >
          {props.children}
        </ResizablePanel>
      </Show>
    </Resizable>
  );
}

const ClientList = (props: {
  collapsed: boolean;
  expand: () => void;
  path: string;
}) => {
  createEffect(() => {
    if (props.collapsed && props.path === "/") {
      props.expand();
    }
  });
  const getLastMessage = (clientId: ClientID) =>
    appState.message.messages.findLast(
      (message) =>
        message.client === clientId ||
        message.target === clientId,
    );

  const clntWithLastMsg = createMemo(() => {
    return appState.message.clients
      .map((client) => {
        return {
          client,
          message: getLastMessage(client.clientId),
          clientInfo: appState.session.clientViewData[
            client.clientId
          ] as ClientInfo | undefined,
        };
      })
      .slice()
      .sort((c1, c2) => {
        const c1Online =
          c1.clientInfo?.onlineStatus === "online";
        const c2Online =
          c2.clientInfo?.onlineStatus === "online";
        if (c1Online && !c2Online) return -1;
        if (!c1Online && c2Online) return 1;

        return (
          (c2.message?.createdAt ?? 0) -
          (c1.message?.createdAt ?? 0)
        );
      });
  });
  return (
    <div
      class="top-0 h-full w-full overflow-x-hidden md:sticky
        md:max-h-[100vh] md:overflow-y-auto"
    >
      <ul
        class={cn(
          "flex h-full w-full flex-col [&>li]:py-1",
          props.collapsed ? "" : "divide-muted divide-y",
        )}
      >
        <For
          each={clntWithLastMsg()}
          fallback={
            <div class="relative h-full w-full overflow-hidden">
              <div
                class="absolute top-1/2 left-1/2 flex w-1/2 -translate-x-1/2
                  -translate-y-1/2 flex-col items-center"
              >
                <IconPerson class="text-muted/10" />
                <p class="text-muted-foreground text-xs md:hidden">
                  {t("client.index.mobile_tip")}
                </p>
              </div>
            </div>
          }
        >
          {({ client, message }) => (
            <UserItem
              message={message}
              client={client}
              collapsed={props.collapsed}
            />
          )}
        </For>
      </ul>
    </div>
  );
};
