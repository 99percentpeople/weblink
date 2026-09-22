import { findMessageTransfer } from "@/libs/application/transfer/file-transfer-state";
import {
  RouteSectionProps,
  useNavigate,
  useParams,
} from "@solidjs/router";
import { useAppState } from "@/libs/state/app-state-context";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import {
  createScrollEnd,
  keepBottom,
} from "@/libs/hooks/keep-bottom";
import { cn } from "@/libs/cn";
import DropArea from "@/components/drop-area";
import { FloatingButton } from "./components/floating-button";
import { createElementSize } from "@solid-primitives/resize-observer";
import PhotoSwipeLightbox from "photoswipe/lightbox";
// @ts-ignore
import PhotoSwipeVideoPlugin from "photoswipe-video-plugin";
import {
  messageStores,
  StoreMessage,
} from "@/libs/application/messaging/message-store";
import { ChatBar } from "@/routes/client/[id]/components/chat-bar";
import {
  IconArrowDownward,
  IconClose,
  IconPlaceItem,
} from "@/components/icons";
import { t } from "@/i18n";
import { toast } from "solid-sonner";
import { PeerSession } from "@/libs/core/session";
import { handleDropItems } from "@/libs/utils/process-file";
import type { Client } from "@/libs/core/client";
import type { ClientInfo } from "@/libs/state/app-state";
import { catchError } from "@/libs/catch";
import { ChatMoreMessageButton } from "./components/chat-more-message-button";
import { MessageContent } from "./components/message";
import { ChatHeader } from "./components/chat-header";
import { appState } from "@/libs/state/app-state";
import { transferManager } from "@/libs/application/transfer/transfer-service";
import { cacheManager } from "@/libs/application/cache-service";
import { createDeleteFileMessageDialog } from "@/components/dialogs/delete-file-message-dialog";

export default function ClientPage(
  props: RouteSectionProps,
) {
  const navigate = useNavigate();
  const params = useParams<{ id: string }>();
  const { sendFile, sendClipboard } = useAppState();
  const client = createMemo<Client | null>(
    () =>
      appState.message.clients.find(
        (client) => client.clientId === params.id,
      ) ?? null,
  );
  const clientInfo = createMemo<ClientInfo | undefined>(
    () => appState.session.clientViewData[params.id],
  );
  createEffect(() => {
    if (appState.message.status === "ready" && !client()) {
      navigate("/", { replace: true });
    }
  });

  const position = createScrollEnd(document);

  const isBottom = createMemo(() => {
    const pos = position();
    if (!pos) return true;

    return pos.height <= pos.bottom + 10;
  });

  const [enable, setEnable] = createSignal(true);
  createEffect(() => {
    if (enable() !== isBottom()) {
      setEnable(isBottom());
    }
  });

  const [messages, setMessages] = createSignal<
    StoreMessage[]
  >([]);

  const allMessages = createMemo<StoreMessage[]>(
    () =>
      appState.message.messages.filter(
        (message) =>
          message.client === params.id ||
          message.target === params.id,
      ) ?? [],
  );

  const getMoreMessages = (count: number) => {
    const msgs: StoreMessage[] = [];
    const currentMessages = untrack(messages);
    const totalMessages = untrack(allMessages);

    const tailIndex =
      totalMessages.length - currentMessages.length - 1;
    if (tailIndex < 0) {
      return;
    }
    for (let i = tailIndex; i >= 0; i--) {
      if (msgs.length >= count) break;
      const message = totalMessages[i];
      msgs.push(message);
    }
    setMessages([...msgs.reverse(), ...currentMessages]);
  };

  // load messages after message store is ready
  createEffect(() => {
    if (props.location.pathname) {
      setMessages([]);
    }

    if (appState.message.status === "ready") {
      getMoreMessages(20);
    }
  });

  // always keep the last message in the message list
  createEffect(() => {
    if (allMessages().length === 0) return;

    const lastMessage =
      allMessages()[allMessages().length - 1];
    if (!lastMessage) return;
    const currentLastMessage =
      messages()[messages().length - 1];
    if (!currentLastMessage) {
      setMessages([lastMessage]);
      return;
    }

    if (lastMessage.id === currentLastMessage.id) return;

    // if delete last message, do nothing
    if (messages().length > 1) {
      const secondLastMessage =
        messages()[messages().length - 2];
      if (secondLastMessage?.id === lastMessage.id) {
        return;
      }
    }

    setMessages([...messages(), lastMessage]);
    toBottom(10, false);
  });
  let toBottom: (
    delay: number | undefined,
    instant: boolean,
  ) => void;
  onMount(() => {
    toBottom = keepBottom(document, enable);
    createEffect(() => {
      if (props.location.pathname !== "/") {
        toBottom(0, true);
        toBottom(100, true);
      }
    });

    createEffect(() => {
      if (
        clientInfo()?.onlineStatus === "online" &&
        enable()
      ) {
        toBottom(100, true);
      }
    });
  });

  const [loaded, setLoaded] = createSignal(false);

  createEffect(() => {
    if (loaded()) {
      toBottom(0, true);
    }
  });

  const [bottomElem, setBottomElem] =
    createSignal<HTMLElement>();
  const size = createElementSize(bottomElem);
  const { open: openDeleteFileMessageDialog } =
    createDeleteFileMessageDialog();

  const session = createMemo<PeerSession | null>(
    () =>
      (clientInfo() &&
        appState.session.sessions[
          clientInfo()!.clientId
        ]) ??
      null,
  );

  const onClipboard = (ev: ClipboardEvent) => {
    const s = session();
    if (!s) return;
    for (const item of ev.clipboardData?.items ?? []) {
      if (item.kind === "string") {
        item.getAsString((data) => {
          if (data) {
            void sendClipboard(data, s.targetClientId);
          }
        });
        break;
      }
    }
  };

  onMount(() => {
    if (
      navigator.clipboard &&
      appState.options.enableClipboard
    ) {
      window.addEventListener("paste", onClipboard);

      onCleanup(() => {
        window.removeEventListener("paste", onClipboard);
      });
    }
  });

  let loadedTimer: number | undefined;

  const deleteMessage = async (message: StoreMessage) => {
    if (message.type === "file") {
      const fid = message.fid;
      const hasTransfer = !!findMessageTransfer(
        appState.transfer.transfers,
        message,
      );
      const hasCache =
        fid !== undefined &&
        appState.cache.caches[fid] !== undefined;

      const { result, cancel } =
        await openDeleteFileMessageDialog({
          fileName: message.fileName,
          hasTransfer,
          hasCache,
        });

      if (cancel) return;

      if (fid !== undefined && result?.deleteTransfer) {
        const active = findMessageTransfer(
          appState.transfer.transfers,
          message,
        );
        if (active) {
          const run = transferManager.get(
            active.session,
            fid,
          );
          if (run?.id === active.id)
            transferManager.destroy(run);
        }
      }

      if (fid !== undefined && result?.deleteCache) {
        transferManager.destroyFile(fid);
        const [error] = await catchError(
          cacheManager.remove(fid),
        );
        if (error) {
          console.error(error);
          toast.error(error.message);
        }
      }
    }

    if (messageStores.deleteMessage(message.id)) {
      setMessages(
        messages().filter((m) => m.id !== message.id),
      );
    }
  };

  return (
    <div class="flex h-full w-full flex-col">
      <Show when={client()}>
        {(client) => (
          <div class={cn("flex flex-1 flex-col [&>*]:p-2")}>
            <FloatingButton
              onClick={async () => {
                toBottom?.(0, false);
              }}
              delay={500}
              duration={150}
              isVisible={!enable()}
              class="data-[expanded]:animate-in data-[closed]:animate-out
                data-[closed]:fade-out-0 data-[expanded]:fade-in-0
                data-[closed]:zoom-out-75 data-[expanded]:zoom-in-75 fixed
                z-50 size-12 rounded-full shadow-md backdrop-blur"
              style={{
                bottom: `${16 + (size.height ?? 0)}px`,
                right:
                  "calc(1rem + var(--scrollbar-width, 0px))",
              }}
            >
              <IconArrowDownward class="size-6 sm:size-8" />
            </FloatingButton>
            <ChatHeader
              info={clientInfo()}
              client={client()}
              class="border-border bg-background/80 sticky
                top-[var(--mobile-header-height)] z-10 flex items-center
                justify-between gap-1 border-b backdrop-blur md:top-0"
            />
            <DropArea
              class="relative flex-1"
              overlay={(ev) => {
                if (!ev) return;
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
                  <div class="bg-muted/50 pointer-events-none absolute inset-0 text-center">
                    <span
                      class="text-muted-foreground/20 fixed top-1/2 -translate-x-1/2"
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
                if (!ev.dataTransfer?.items) return;
                const abortController =
                  new AbortController();
                const toastId = toast.loading(
                  t("common.notification.processing_files"),
                  {
                    duration: Infinity,
                    action: {
                      label: t("common.action.cancel"),
                      onClick: () =>
                        abortController.abort(
                          "User cancelled",
                        ),
                    },
                  },
                );

                const [error, files] = await catchError(
                  handleDropItems(
                    ev.dataTransfer.items,
                    abortController.signal,
                  ),
                );
                toast.dismiss(toastId);
                if (error) {
                  console.warn(error);
                  if (error.message !== "User cancelled") {
                    toast.error(error.message);
                  }
                  return;
                }

                files.forEach((file) => {
                  sendFile(file, client().clientId);
                });
              }}
            >
              <ul
                class="flex flex-col gap-2 p-2"
                ref={(ref) => {
                  onMount(() => {
                    const lightbox = new PhotoSwipeLightbox(
                      {
                        gallery: ref,
                        bgOpacity: 0.8,
                        children: "a#pswp-item",
                        initialZoomLevel: "fit",
                        closeOnVerticalDrag: true,
                        // wheelToZoom: true, // enable wheel-based zoom
                        pswpModule: () =>
                          import("photoswipe"),
                      },
                    );
                    lightbox.addFilter(
                      "domItemData",
                      (itemData, element, linkEl) => {
                        return itemData;
                      },
                    );
                    lightbox.on("uiRegister", function () {
                      lightbox.pswp?.ui?.registerElement({
                        name: "download-button",
                        order: 8,
                        isButton: true,
                        tagName: "a",
                        html: {
                          isCustomSVG: true,
                          inner:
                            '<path d="M20.5 14.3 17.1 18V10h-2.2v7.9l-3.4-3.6L10 16l6 6.1 6-6.1ZM23 23H9v2h14Z" id="pswp__icn-download"/>',
                          outlineID: "pswp__icn-download",
                        },
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

                    const videoPlugin =
                      new PhotoSwipeVideoPlugin(
                        lightbox,
                        {},
                      );

                    lightbox.init();
                  });
                }}
              >
                <Show
                  when={
                    messages().length !==
                    allMessages().length
                  }
                >
                  <div class="flex justify-center">
                    <ChatMoreMessageButton
                      onIntersect={() => {
                        const prevScrollHeight =
                          document.documentElement
                            .scrollHeight;

                        getMoreMessages(5);

                        document.documentElement.scrollTop +=
                          document.documentElement
                            .scrollHeight -
                          prevScrollHeight;
                      }}
                    />
                  </div>
                </Show>
                <For each={messages()}>
                  {(message, index) => (
                    <MessageContent
                      message={message}
                      onDelete={() => {
                        void deleteMessage(message);
                      }}
                      onLoad={() => {
                        clearTimeout(loadedTimer);
                        loadedTimer = window.setTimeout(
                          () => {
                            setLoaded(true);
                            if (
                              index() ===
                              messages().length - 1
                            ) {
                              toBottom(100, true);
                            }
                          },
                          100,
                        );
                      }}
                      class={cn(
                        index() === messages().length - 1 &&
                          "animate-message mb-20",
                      )}
                    />
                  )}
                </For>
              </ul>
            </DropArea>
            <Show
              when={
                clientInfo()?.onlineStatus === "online" &&
                clientInfo()?.messageChannel
              }
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
