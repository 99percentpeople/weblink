import {
  RouteSectionProps,
  useNavigate,
} from "@solidjs/router";
import { useWebRTC } from "@/libs/core/rtc-context";
import {
  createEffect,
  createMemo,
  createSignal,
  Index,
  onMount,
  Show,
} from "solid-js";

import { Button } from "@/components/ui/button";
import {
  createScrollEnd,
  keepBottom,
} from "@/libs/hooks/keep-bottom";
import { cn } from "@/libs/cn";
import DropArea from "@/components/drop-area";
import { A } from "@solidjs/router";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { createDialog } from "@/components/dialogs/dialog";

import { FloatingButton } from "@/components/floating-button";
import { createElementSize } from "@solid-primitives/resize-observer";

import PhotoSwipeLightbox from "photoswipe/lightbox";
import {
  messageStores,
  StoreMessage,
} from "@/libs/core/messge";
import { getInitials } from "@/libs/utils/name";
import {
  ChatBar,
  MessageContent,
} from "@/components/chat/message";
import { sessionService } from "@/libs/services/session-service";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  IconArrowDownward,
  IconChevronLeft,
  IconClose,
  IconConnectWithoutContract,
  IconDataInfoAlert,
  IconDelete,
  IconMenu,
  IconPlaceItem,
} from "@/components/icons";
import { createComfirmDeleteClientDialog } from "@/components/ui/confirm-delete-dialog";
import { t } from "@/i18n";
import { ConnectionBadge } from "@/components/chat/clientlist";
export default function ClientPage(
  props: RouteSectionProps,
) {
  const navigate = useNavigate();
  const { send } = useWebRTC();
  const client = createMemo(() =>
    messageStores.clients.find(
      (client) => client.clientId === props.params.id,
    ),
  );
  const clientInfo = createMemo(
    () => sessionService.clientInfo[props.params.id],
  );
  createEffect(() => {
    if (messageStores.status() === "ready" && !client()) {
      navigate("/", { replace: true });
    }
  });

  const { open: openDialog, Component: DialogComponent } =
    createDialog({
      title: () =>
        t("common.client_info_dialog.title", {
          name: client()?.name,
        }),
      content: () => (
        <Show
          when={clientInfo()}
          fallback={t("common.client_info_dialog.leave")}
        >
          {(info) => (
            <div class="grid grid-cols-3 gap-4 overflow-y-auto">
              <p class="justify-self-end">
                {t("common.client_info_dialog.status")}
              </p>
              <p class="col-span-2">
                {info()?.onlineStatus}
              </p>
              <p class="justify-self-end">
                {t("common.client_info_dialog.client_id")}
              </p>
              <p class="col-span-2 text-sm">
                {info().clientId}
              </p>
              <p class="justify-self-end">
                {t("common.client_info_dialog.created_at")}
              </p>
              <p class="col-span-2">
                {new Date(
                  info().createdAt,
                ).toLocaleString()}
              </p>

              <div class="col-span-3">
                <pre class="overflow-x-auto font-mono text-xs">
                  {JSON.stringify(
                    info().statsReports,
                    null,
                    2,
                  )}
                </pre>
              </div>
            </div>
          )}
        </Show>
      ),
    });

  const position = createScrollEnd(document);

  const isBottom = createMemo(() => {
    const pos = position();
    if (!pos) return true;

    return pos.height <= pos.bottom + 1;
  });

  const [enable, setEnable] = createSignal(true);
  createEffect(() => {
    setEnable(isBottom());
  });

  const messages = createMemo<StoreMessage[]>(
    () =>
      messageStores.messages.filter(
        (message) =>
          message.client === props.params.id ||
          message.target === props.params.id,
      ) ?? [],
  );
  let toBottom: (
    delay: number | undefined,
    instant: boolean,
  ) => void;
  onMount(() => {
    toBottom = keepBottom(document, enable);

    createEffect(() => {
      if (props.location.pathname) {
        toBottom(0, true);
      }
    });
  });
  const [bottomElem, setBottomElem] =
    createSignal<HTMLElement>();
  const size = createElementSize(bottomElem);

  const { open, Component } =
    createComfirmDeleteClientDialog();

  return (
    <div class="flex h-full w-full flex-col">
      <Component />
      <Show when={client()}>
        {(client) => (
          <div
            class={cn(
              "flex flex-1 flex-col [&>*]:p-1 md:[&>*]:p-2",
            )}
          >
            <FloatingButton
              onClick={async () => {
                toBottom?.(0, false);
              }}
              delay={150}
              isVisible={!enable()}
              class="fixed z-50 size-12 rounded-full shadow-md backdrop-blur
                data-[expanded]:animate-in data-[closed]:animate-out
                data-[closed]:fade-out-0 data-[expanded]:fade-in-0
                data-[closed]:zoom-out-75 data-[expanded]:zoom-in-75"
              style={{
                bottom: `${16 + (size.height ?? 0)}px`,
                right:
                  "calc(1rem + var(--scrollbar-width, 0px))",
              }}
            >
              <IconArrowDownward class="size-6 sm:size-8" />
            </FloatingButton>

            <DialogComponent class="flex max-h-[90%] flex-col" />
            <div
              class="sticky top-12 z-10 flex items-center justify-between gap-1
                border-b border-border bg-background/80 backdrop-blur"
            >
              <div class="flex w-full items-center gap-2">
                <Button
                  as={A}
                  href="/"
                  size="icon"
                  variant="ghost"
                >
                  <IconChevronLeft class="size-8" />
                </Button>

                <Avatar>
                  <AvatarImage
                    src={client().avatar ?? undefined}
                  />
                  <AvatarFallback>
                    {getInitials(client().name)}
                  </AvatarFallback>
                </Avatar>
                <h4 class={cn("h4")}>{client().name}</h4>
                <ConnectionBadge client={clientInfo()} />

                <DropdownMenu>
                  <DropdownMenuTrigger
                    as={Button}
                    size="icon"
                    variant="ghost"
                    class="ml-auto"
                  >
                    <IconMenu class="size-6" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent class="w-48">
                    <DropdownMenuItem
                      class="gap-2"
                      onSelect={() => {
                        openDialog();
                      }}
                    >
                      <IconDataInfoAlert class="size-4" />
                      {t("chat.menu.connection_status")}
                    </DropdownMenuItem>
                    <Show
                      when={
                        sessionService.sessions[
                          client().clientId
                        ]
                      }
                    >
                      {(session) => (
                        <DropdownMenuItem
                          class="gap-2"
                          onSelect={() => {
                            session().connect();
                          }}
                        >
                          <IconConnectWithoutContract class="size-4" />
                          {t("chat.menu.connect")}
                        </DropdownMenuItem>
                      )}
                    </Show>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      class="gap-2"
                      onSelect={async () => {
                        if (!(await open()).cancel) {
                          messageStores.deleteClient(
                            client().clientId,
                          );
                        }
                      }}
                    >
                      <IconDelete class="size-4" />
                      {t("chat.menu.delete_client")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <DropArea
              class="relative flex-1"
              onDragOver={(ev) => {
                if (ev.dataTransfer) {
                  const hasFiles =
                    ev.dataTransfer?.types.includes(
                      "Files",
                    );

                  if (hasFiles) {
                    ev.dataTransfer.dropEffect = "move";
                  } else {
                    ev.dataTransfer.dropEffect = "none";
                  }
                }
                return (
                  <div class="pointer-events-none absolute inset-0 bg-muted/50 text-center">
                    <span
                      class="fixed top-1/2 -translate-x-1/2 text-muted/50"
                      style={{
                        "--tw-translate-y": `-${(size.height ?? 0) / 2}px`,
                      }}
                    >
                      <Show
                        when={
                          ev.dataTransfer?.dropEffect ===
                          "move"
                        }
                        fallback={
                          <IconClose class="size-32" />
                        }
                      >
                        <IconPlaceItem class="size-32" />
                      </Show>
                    </span>
                  </div>
                );
              }}
              onDrop={async (ev) => {
                const files = ev.dataTransfer?.files;
                if (!files) return;
                for (let i = 0; i < files.length; i++) {
                  const file = files.item(i)!;
                  send(file, {
                    target: client().clientId,
                  });
                }
              }}
            >
              <ul
                class="flex flex-col gap-2 p-2 pb-[15%] pt-[15%] lg:pb-[10%]
                  lg:pt-[10%] xl:pb-[5%] xl:pt-[5%]"
                ref={(ref) => {
                  onMount(() => {
                    const lightbox = new PhotoSwipeLightbox(
                      {
                        gallery: ref,
                        bgOpacity: 0.8,
                        children: "a#image",
                        initialZoomLevel: "fit",
                        closeOnVerticalDrag: true,
                        // wheelToZoom: true, // enable wheel-based zoom

                        pswpModule: () =>
                          import("photoswipe"),
                      },
                    );
                    lightbox.on("uiRegister", function () {
                      lightbox.pswp?.ui?.registerElement({
                        name: "download-button",
                        order: 8,
                        isButton: true,
                        tagName: "a",

                        // SVG with outline
                        html: {
                          isCustomSVG: true,
                          inner:
                            '<path d="M20.5 14.3 17.1 18V10h-2.2v7.9l-3.4-3.6L10 16l6 6.1 6-6.1ZM23 23H9v2h14Z" id="pswp__icn-download"/>',
                          outlineID: "pswp__icn-download",
                        },

                        // Or provide full svg:
                        // html: '<svg width="32" height="32" viewBox="0 0 32 32" aria-hidden="true" class="pswp__icn"><path d="M20.5 14.3 17.1 18V10h-2.2v7.9l-3.4-3.6L10 16l6 6.1 6-6.1ZM23 23H9v2h14Z" /></svg>',

                        // Or provide any other markup:
                        // html: '<i class="fa-solid fa-download"></i>'

                        onInit: (el, pswp) => {
                          const e = el as HTMLAnchorElement;

                          e.setAttribute(
                            "target",
                            "_blank",
                          );
                          e.setAttribute("rel", "noopener");

                          pswp.on("change", () => {
                            e.download =
                              pswp.currSlide?.data.element
                                ?.dataset.download ?? "";

                            e.href =
                              pswp.currSlide?.data.src ??
                              "";
                          });
                        },
                      });
                    });
                    lightbox.init();
                  });
                }}
              >
                <Index each={messages()}>
                  {(message) => (
                    <MessageContent message={message()} />
                  )}
                </Index>
              </ul>
            </DropArea>
            <Show
              when={clientInfo()?.onlineStatus === "online"}
            >
              <ChatBar
                client={client()}
                ref={setBottomElem}
              />
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
