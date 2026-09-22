import {
  For,
  createMemo,
  createEffect,
  Show,
  createSignal,
  ComponentProps,
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
import type { ClientID } from "@/libs/core/ids";
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

export default function Home(props: RouteSectionProps) {
  const isMobile = createIsMobile();
  const navigate = useNavigate();
  const matches = useCurrentMatches();
  const [size, setSize] = makePersisted(
    createSignal<number[]>(),
    {
      storage: sessionStorage,
      name: "resizable-sizes",
    },
  );
  const path = createMemo<string | undefined>(() => {
    return matches()[matches().length - 1]?.path;
  });
  createEffect(() => {
    if (isMobile()) {
      if (path() === "/") {
        setSize([1, 0]);
      } else {
        setSize([1]);
      }
    }
  });

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
      sizes={size()}
      onSizesChange={(sizes) => setSize(sizes)}
    >
      <Show when={!isMobile() || path() === "/"}>
        <ResizablePanel
          class={cn(
            `bg-background/80 backdrop-blur
            data-[collapsed]:transition-all data-[collapsed]:ease-in-out`,
          )}
          collapsible
          initialSize={0.2}
          maxSize={0.3}
          minSize={0.15}
        >
          {(props) => (
            <ClientList
              collapsed={props.collapsed}
              expand={props.expand}
              path={path() ?? ""}
            />
          )}
        </ResizablePanel>
      </Show>
      <Show when={!isMobile()}>
        <ResizableHandle />
      </Show>

      <Show when={!isMobile() || path() !== "/"}>
        <ResizablePanel
          class="relative"
          minSize={0.7}
          initialSize={0.8}
        >
          {(resizeProps) => {
            createEffect(() => {
              if (!isMobile() && (size()?.[1] ?? 0) < 0.7) {
                resizeProps.resize(0.7);
              }
            });

            return <>{props.children}</>;
          }}
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
