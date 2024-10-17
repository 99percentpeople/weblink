import {
  Avatar,
  AvatarFallback,
} from "@/components/ui/avatar";
import {
  Component,
  For,
  createMemo,
  Switch,
  Match,
  createEffect,
  Show,
  createSignal,
  ComponentProps,
  splitProps,
  Suspense,
} from "solid-js";
import { cn } from "@/libs/cn";

import {
  A,
  RouteSectionProps,
  useCurrentMatches,
} from "@solidjs/router";
import { ClientID, ClientInfo } from "@/libs/core/type";

import {
  Resizable,
  ResizableHandle,
  ResizablePanel,
} from "@/components/ui/resizable";

import { createMediaQuery } from "@solid-primitives/media";
import { makePersisted } from "@solid-primitives/storage";
import { IconPerson } from "@/components/icons";
import { UserItem } from "@/components/chat/userlist";
import { messageStores } from "@/libs/core/messge";
import { t } from "@/i18n";

export interface UserItemProps
  extends ComponentProps<"li"> {
  client: ClientInfo;
  collapsed: boolean;
}

export default function Home(props: RouteSectionProps) {
  const isMobile = createMediaQuery("(max-width: 767px)");

  const matches = useCurrentMatches();
  const [size, setSize] = makePersisted(
    createSignal<number[]>(),
    {
      storage: sessionStorage,
      name: "resizable-sizes",
    },
  );
  createEffect(() => {
    if (isMobile()) {
      if (matches()[matches().length - 1].path === "/") {
        setSize([1, 0]);
      } else {
        setSize([0, 1]);
      }
    } else {
    }
  });

  const getLastMessage = (clientId: ClientID) =>
    messageStores.messages.findLast(
      (message) =>
        message.client === clientId ||
        message.target === clientId,
    );

  const clntWithLastMsg = createMemo(() => {
    return messageStores.clients
      .map((client) => {
        return {
          client,
          message: getLastMessage(client.clientId),
        };
      })
      .toSorted(
        (c1, c2) =>
          (c2.message?.createdAt ?? 0) -
          (c1.message?.createdAt ?? 0),
      );
  });

  return (
    <Resizable
      sizes={size()}
      onSizesChange={(sizes) => setSize(sizes)}
      class="size-auto min-h-[calc(100%-3rem)] w-full"
    >
      <ResizablePanel
        class={cn(
          "data-[collapsed]:transition-all data-[collapsed]:ease-in-out",
          isMobile() &&
            matches()[matches().length - 1].path !== "/" &&
            "hidden",
        )}
        collapsible
        initialSize={0.2}
        maxSize={0.4}
        minSize={0.1}
      >
        {(props) => {
          createEffect(() => {
            if (
              props.collapsed &&
              matches()[matches().length - 1].path === "/"
            ) {
              props.expand();
            }
          });
          return (
            <div
              class="h-full w-full overflow-x-hidden md:sticky
                md:top-[calc(3rem)] md:h-[calc(100vh_-_3rem)]
                md:overflow-y-auto"
            >
              <ul
                class={cn(
                  "flex h-full w-full flex-col bg-background [&>li]:py-1",
                  props.collapsed
                    ? ""
                    : "divide-y divide-muted",
                )}
              >
                <For
                  each={clntWithLastMsg()}
                  fallback={
                    <div class="relative h-full w-full overflow-hidden">
                      <div
                        class="absolute left-1/2 top-1/2 flex -translate-x-1/2
                          -translate-y-1/2 flex-col items-center w-1/2"
                      >
                        <IconPerson class="text-muted/50" />
                        <p class="muted sm:hidden">
                          {t(
                            "chat.index.guide_description",
                          )}
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
        }}
      </ResizablePanel>

      <ResizableHandle
        withHandle
        class={cn(isMobile() && "hidden")}
      />

      <ResizablePanel
        class={cn(
          isMobile() &&
            matches()[matches().length - 1].path === "/" &&
            "hidden",
        )}
        minSize={0.6}
        initialSize={0.8}
      >
        {(resizeProps) => {
          createEffect(() => {
            if (!isMobile() && (size()?.[1] ?? 0) < 0.6) {
              resizeProps.resize(0.6);
            }
          });
          return props.children;
        }}
      </ResizablePanel>
    </Resizable>
  );
}
