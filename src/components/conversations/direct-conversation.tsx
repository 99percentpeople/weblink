import { userErrorMessage } from "@/libs/user-error";
import { useLocation } from "@solidjs/router";
import { findMessageTransfer } from "@/libs/application/transfer/file-transfer-state";
import { useAppState } from "@/libs/state/app-state-context";
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { createBottomScroll } from "@/libs/hooks/create-bottom-scroll";
import { cn } from "@/libs/cn";
import DropArea from "@/components/drop-area";
import { ChatScrollButton } from "./chat-scroll-button";
import { ChatEmptyState } from "./chat-empty-state";
import { createMessageGallery } from "./message-gallery";
import {
  messageStores,
  StoreMessage,
} from "@/libs/application/messaging/message-store";
import { ChatBar } from "@/routes/client/[id]/components/chat-bar";
import {
  IconClose,
  IconPlaceItem,
} from "@/components/icons";
import { t } from "@/i18n";
import { toast } from "solid-sonner";
import { PeerSession } from "@/libs/domain/session";
import { handleDropItems } from "@/libs/utils/process-file";
import type { Client } from "@/libs/domain/client";
import type { ClientInfo } from "@/libs/state/app-state";
import { catchError } from "@/libs/catch";
import { ChatMoreMessageButton } from "@/routes/client/[id]/components/chat-more-message-button";
import { MessageContent } from "@/routes/client/[id]/components/message";
import { createMessageLayout } from "@/routes/client/[id]/components/message-layout";
import { ChatTimeSeparator } from "@/routes/client/[id]/components/chat-time-separator";
import { ClientHeader } from "@/routes/client/[id]/components/client-header";
import { appState } from "@/libs/state/app-state";
import { transferManager } from "@/libs/application/transfer/transfer-service";
import { cacheManager } from "@/libs/application/cache-service";
import { createDeleteFileMessageDialog } from "@/components/dialogs/delete-file-message-dialog";
import { directConversationId } from "@/libs/domain/conversation";
import { createConversationReadTracking } from "@/libs/hooks/conversation-read";

interface MessageWindow {
  ready: boolean;
  messages: StoreMessage[];
  visibleCount: number;
  historyRevision: number;
  lastId: string | undefined;
  animatedIds: ReadonlySet<string>;
  appendRevision: number;
}

export function ChatConversation(props: {
  clientId: string;
  conversationId?: string;
  embedded?: boolean;
  onBack?: () => void;
}) {
  const { sendFile, sendClipboard } = useAppState();
  const routeLocation = useLocation();
  const client = createMemo<Client | null>(
    () =>
      appState.message.clients.find(
        (client) => client.clientId === props.clientId,
      ) ??
      (props.conversationId
        ? {
            clientId: props.clientId,
            name:
              appState.message.conversations.find(
                (item) => item.id === props.conversationId,
              )?.title ?? props.clientId,
            avatar: null,
          }
        : null),
  );
  const clientInfo = createMemo<ClientInfo | undefined>(
    () => appState.session.clientViewData[props.clientId],
  );
  const liveConversationId = () =>
    directConversationId(
      appState.profile.clientId,
      props.clientId,
    );

  const conversationId = () =>
    props.conversationId ?? liveConversationId();
  const currentIdentity = () =>
    conversationId() === liveConversationId();
  const canSend = () =>
    currentIdentity() &&
    clientInfo()?.onlineStatus === "online" &&
    !!clientInfo()?.messageChannel;
  const [historyRevision, setHistoryRevision] =
    createSignal(0);
  const ready = () => appState.message.status === "ready";
  const allMessages = createMemo(() =>
    appState.message.messages.filter((message) =>
      message.conversationId
        ? message.conversationId === conversationId()
        : !message.room &&
          (message.client === props.clientId ||
            message.target === props.clientId),
    ),
  );

  // Project the message slice and append intent atomically. Updating the slice
  // first and its count in an effect briefly removes old rows on every batch,
  // which makes scroll anchoring compensate in both directions.
  const messageWindow = createMemo<MessageWindow>(
    (previous) => {
      const loaded = ready();
      const next = allMessages();
      const history = historyRevision();
      if (!loaded || !previous?.ready) {
        return {
          ready: loaded,
          messages: loaded ? next.slice(-20) : [],
          visibleCount: 20,
          historyRevision: history,
          lastId: next.at(-1)?.id,
          animatedIds: new Set<string>(),
          appendRevision: 0,
        };
      }

      const index = previous.lastId
        ? next.findIndex(
            (message) => message.id === previous.lastId,
          )
        : -1;
      const added =
        previous.lastId && index === -1
          ? []
          : next.slice(index + 1);
      const count =
        previous.visibleCount +
        added.length +
        history -
        previous.historyRevision;
      return {
        ready: true,
        messages: next.slice(-count),
        visibleCount: count,
        historyRevision: history,
        lastId: next.at(-1)?.id,
        animatedIds: added.length
          ? new Set(added.map((message) => message.id))
          : previous.animatedIds,
        appendRevision:
          previous.appendRevision + (added.length ? 1 : 0),
      };
    },
  );
  const messages = () => messageWindow().messages;
  const messageLayout = createMemo(() =>
    createMessageLayout(messages()),
  );
  const scroll = createBottomScroll({
    ready,
    revision: messages,
    appendRevision: () => messageWindow().appendRevision,
  });
  const loadMore = () => {
    if (!scroll.positioned()) return;
    scroll.preservePosition(() => {
      setHistoryRevision((count) => count + 5);
    });
  };
  createConversationReadTracking(
    conversationId,
    allMessages,
    () => scroll.positioned() && scroll.following(),
  );
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
    if (!canSend()) return;
    if (
      props.embedded &&
      !(
        ev.target instanceof Node &&
        container?.contains(ev.target)
      )
    )
      return;
    const s = session();
    if (!s) return;
    for (const item of ev.clipboardData?.items ?? []) {
      if (item.kind === "string") {
        item.getAsString((data) => {
          if (
            data &&
            canSend() &&
            props.clientId === s.targetClientId
          ) {
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
          cacheManager.getCache(fid)?.cleanup() ??
            Promise.resolve(),
        );
        if (error) {
          console.error(error);
          toast.error(
            userErrorMessage(error, "errors.file_failed"),
          );
        }
      }
    }

    messageStores.deleteMessage(message.id);
  };

  let container: HTMLDivElement | undefined;
  return (
    <div
      ref={container}
      data-slot="chat-page"
      class={cn(
        "flex min-h-0 w-full flex-col overflow-hidden",
        props.embedded
          ? "h-full"
          : "h-[calc(100dvh-var(--mobile-header-height))] md:h-dvh",
      )}
    >
      <Show when={client()}>
        {(client) => (
          <div class="flex min-h-0 flex-1 flex-col">
            <ClientHeader
              clientId={client().clientId}
              conversationId={conversationId()}
              client={client()}
              info={clientInfo()}
              view="chat"
              embedded={props.embedded}
              onBack={props.onBack}
              class="static"
            />
            <DropArea
              class="relative min-h-0 flex-1"
              overlay={(ev) => {
                if (!ev) return;
                if (ev.dataTransfer) {
                  const hasFiles =
                    canSend() &&
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
                  <div
                    class="bg-muted/50 pointer-events-none absolute inset-0 z-10 grid
                      place-items-center"
                  >
                    <span class="text-muted-foreground/20">
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
                if (!canSend()) return;
                if (!ev.dataTransfer?.items) return;
                const target = props.clientId;
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
                    toast.error(
                      userErrorMessage(
                        error,
                        "errors.file_failed",
                      ),
                    );
                  }
                  return;
                }

                try {
                  for (const file of files) {
                    if (
                      !canSend() ||
                      props.clientId !== target
                    )
                      break;
                    await sendFile(file, target);
                  }
                } catch (error) {
                  toast.error(
                    error instanceof Error
                      ? error.message
                      : t(
                          "common.notification.unknown_error",
                        ),
                  );
                }
              }}
            >
              <div
                ref={scroll.viewportRef}
                data-slot="chat-viewport"
                tabIndex={0}
                class="scrollbar-thin scrollbar-thumb-border
                  scrollbar-track-transparent h-full overflow-y-auto
                  overscroll-contain outline-none"
                style={{ "overflow-anchor": "none" }}
              >
                <ul
                  class="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-1 px-3
                    py-4 sm:px-5 sm:py-5"
                  classList={{
                    invisible: !scroll.positioned(),
                  }}
                  aria-busy={!scroll.positioned()}
                  ref={(ref) => {
                    scroll.contentRef(ref);
                    createMessageGallery(ref, {
                      conversationId,
                      hash: () => routeLocation.hash,
                      ready: () =>
                        ready() && scroll.positioned(),
                      revision: allMessages,
                      reveal: (id) => {
                        const index =
                          allMessages().findIndex(
                            (message) => message.id === id,
                          );
                        if (index < 0) return;
                        const missing =
                          allMessages().length -
                          index -
                          messageWindow().visibleCount;
                        if (missing > 0)
                          scroll.preservePosition(() =>
                            setHistoryRevision(
                              (count) => count + missing,
                            ),
                          );
                      },
                      scrollTo: (element) =>
                        scroll.toElement?.(element),
                    });
                  }}
                >
                  <Show
                    when={
                      messages().length !==
                      allMessages().length
                    }
                  >
                    <li class="flex justify-center">
                      <ChatMoreMessageButton
                        viewport={scroll.viewport()}
                        enabled={
                          scroll.positioned() &&
                          !scroll.following()
                        }
                        onIntersect={loadMore}
                      />
                    </li>
                  </Show>
                  <Show
                    when={ready() && !allMessages().length}
                  >
                    <ChatEmptyState />
                  </Show>
                  <For each={messages()}>
                    {(message, index) => {
                      const layout = () =>
                        messageLayout()[index()];
                      return (
                        <>
                          <Show
                            when={layout().timeSeparator}
                          >
                            <ChatTimeSeparator
                              timestamp={message.createdAt}
                            />
                          </Show>
                          <MessageContent
                            data-chat-message={message.id}
                            message={message}
                            joinedPrevious={
                              layout().joinedPrevious
                            }
                            joinedNext={layout().joinedNext}
                            onDelete={() => {
                              void deleteMessage(message);
                            }}
                            class={cn(
                              !layout().joinedPrevious &&
                                !layout().timeSeparator &&
                                "mt-2",
                              messageWindow().animatedIds.has(
                                message.id,
                              ) && "animate-message",
                            )}
                          />
                        </>
                      );
                    }}
                  </For>
                </ul>
              </div>
              <ChatScrollButton
                visible={
                  scroll.positioned() && !scroll.following()
                }
                onClick={() => scroll.toBottom()}
              />
            </DropArea>
            <Show when={currentIdentity()}>
              <ChatBar
                client={client()}
                class="static shrink-0 p-2"
              />
            </Show>
            <Show when={!currentIdentity()}>
              <p
                class="text-muted-foreground shrink-0 border-t p-3 text-center
                  text-xs"
              >
                {t("conversations.previous_identity")}
              </p>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
