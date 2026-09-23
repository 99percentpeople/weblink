import {
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { A, useLocation } from "@solidjs/router";
import { makePersisted } from "@solid-primitives/storage";
import { ChevronLeft, Users, Video } from "lucide-solid";
import { createRoomInfoDialog } from "@/components/dialogs/room-info-dialog";
import { IconSettings } from "@/components/icons";
import { Button } from "@/components/ui/button";
import { ChatComposer } from "./chat-composer";
import { ChatScrollButton } from "./chat-scroll-button";
import { createSendItemPreviewDialog } from "@/components/dialogs/preview-dialog";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import { messageStores } from "@/libs/application/messaging/message-store";
import type { Conversation } from "@/libs/domain/conversation";
import type { StoreMessage } from "@/libs/domain/message";
import { ROOM_CHAT_MAX_TEXT_LENGTH } from "@/libs/domain/protocol/messages";
import { createBottomScroll } from "@/libs/hooks/create-bottom-scroll";
import { createConversationReadTracking } from "@/libs/hooks/conversation-read";
import { MessageContent } from "@/routes/client/[id]/components/message";
import { createMessageLayout } from "@/routes/client/[id]/components/message-layout";
import { ChatTimeSeparator } from "@/routes/client/[id]/components/chat-time-separator";
import { createMessageGallery } from "./message-gallery";
import { cn } from "@/libs/cn";
import { t } from "@/i18n";

export function RoomConversation(props: {
  conversation: Conversation & { kind: "room" };
  embedded?: boolean;
}) {
  const state = useAppState();
  const routeLocation = useLocation();
  const { open: openRoomInfo } = createRoomInfoDialog();
  const active = () =>
    state.activeRoomConversationId() ===
    props.conversation.id;
  const peers = createMemo(() =>
    active()
      ? Object.values(
          appState.session.clientViewData,
        ).filter(
          (client) =>
            client?.onlineStatus === "online" &&
            client.messageChannel,
        )
      : [],
  );
  const canSend = () =>
    active() &&
    peers().some(
      (peer) =>
        state.roomChatCapabilities()[peer.clientId] !==
        "unsupported",
    );
  const [draft, setDraft] = makePersisted(
    createSignal(""),
    {
      storage: sessionStorage,
      name: `conversation-draft:${props.conversation.id}`,
    },
  );
  const { open: openPreview } =
    createSendItemPreviewDialog();
  const fileCapabilities = () =>
    state.roomFileCapabilities?.();
  const canSendFiles = () =>
    active() &&
    peers().some((peer) => {
      const capability =
        fileCapabilities()?.[peer.clientId] ?? "checking";
      return (
        capability === "checking" ||
        capability === "supported"
      );
    });
  const [historyCount, setHistoryCount] = createSignal(40);
  const allMessages = createMemo(() =>
    appState.message.messages.filter(
      (message) =>
        message.conversationId === props.conversation.id,
    ),
  );
  const windowed = createMemo<{
    messages: StoreMessage[];
    count: number;
    history: number;
    lastId?: string;
    revision: number;
  }>((previous) => {
    const all = allMessages();
    const lastIndex = previous?.lastId
      ? all.findIndex(
          (message) => message.id === previous.lastId,
        )
      : -1;
    const added =
      previous && lastIndex >= 0
        ? all.length - lastIndex - 1
        : 0;
    const count = previous
      ? previous.count +
        added +
        historyCount() -
        previous.history
      : historyCount();
    return {
      messages: all.slice(-count),
      count,
      history: historyCount(),
      lastId: all.at(-1)?.id,
      revision:
        (previous?.revision ?? 0) +
        (added > 0 || (!previous?.lastId && all.length > 0)
          ? 1
          : 0),
    };
  });
  const messages = () => windowed().messages;
  const layout = createMemo(() =>
    createMessageLayout(messages()),
  );
  const scroll = createBottomScroll({
    ready: () => appState.message.status === "ready",
    revision: messages,
    appendRevision: () => windowed().revision,
  });
  createConversationReadTracking(
    () => props.conversation.id,
    allMessages,
    () => scroll.positioned() && scroll.following(),
  );
  return (
    <section
      data-slot="room-conversation"
      class={cn(
        "flex min-h-0 w-full flex-col overflow-hidden",
        props.embedded
          ? "h-full"
          : "h-[calc(100dvh-var(--mobile-header-height))] md:h-dvh",
      )}
    >
      <header
        class="bg-background/80 flex shrink-0 items-center gap-2 border-b
          p-3"
      >
        <Show when={!props.embedded}>
          <Button
            as={A}
            href="/"
            size="icon"
            variant="ghost"
            aria-label={t("404.home")}
          >
            <ChevronLeft class="size-5" />
          </Button>
        </Show>
        <span
          class="bg-primary/10 text-primary flex size-9 shrink-0 items-center
            justify-center rounded-full"
        >
          <Users class="size-5" />
        </span>
        <div class="min-w-0 flex-1">
          <h2 class="truncate text-sm font-semibold">
            {props.conversation.title}
          </h2>
          <p class="text-muted-foreground text-xs">
            {active()
              ? t("conversations.members_online", {
                  count: peers().length + 1,
                })
              : t("conversations.local_history")}
          </p>
        </div>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          class="shrink-0"
          aria-label={t("room_dialog.open")}
          title={t("room_dialog.open")}
          onClick={() =>
            void openRoomInfo(props.conversation.id)
          }
        >
          <IconSettings class="size-5" />
        </Button>
        <Show when={active() && !props.embedded}>
          <Button
            as={A}
            href="/video"
            size="icon"
            variant="ghost"
            aria-label={t("meeting.title")}
          >
            <Video class="size-5" />
          </Button>
        </Show>
      </header>
      <div class="relative min-h-0 flex-1">
        <div
          ref={scroll.viewportRef}
          data-slot="chat-viewport"
          tabIndex={0}
          class="scrollbar-thin h-full overflow-y-auto overscroll-contain
            outline-none"
          style={{ "overflow-anchor": "none" }}
        >
          <ul
            ref={(element) => {
              scroll.contentRef(element);
              createMessageGallery(element, {
                conversationId: () => props.conversation.id,
                hash: () => routeLocation.hash,
                ready: () =>
                  appState.message.status === "ready" &&
                  scroll.positioned(),
                revision: allMessages,
                reveal: (id) => {
                  const index = allMessages().findIndex(
                    (message) => message.id === id,
                  );
                  if (index < 0) return;
                  const missing =
                    allMessages().length -
                    index -
                    windowed().count;
                  if (missing > 0)
                    scroll.preservePosition(() =>
                      setHistoryCount(
                        (count) => count + missing,
                      ),
                    );
                },
                scrollTo: (target) =>
                  scroll.toElement?.(target),
              });
            }}
            class="mx-auto flex min-h-full w-full max-w-5xl flex-col gap-1 px-3
              py-4 sm:px-5"
            classList={{ invisible: !scroll.positioned() }}
            aria-busy={!scroll.positioned()}
          >
            <Show
              when={
                messages().length < allMessages().length
              }
            >
              <li class="flex justify-center">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    scroll.preservePosition(() =>
                      setHistoryCount(
                        (count) => count + 40,
                      ),
                    )
                  }
                >
                  {t("conversations.load_earlier")}
                </Button>
              </li>
            </Show>
            <Show when={!messages().length}>
              <li
                class="text-muted-foreground m-auto max-w-72 px-4 text-center
                  text-sm"
              >
                <Users class="mx-auto mb-3 size-10 opacity-30" />
                {t("conversations.room_empty")}
              </li>
            </Show>
            <For each={messages()}>
              {(message, index) => (
                <>
                  <Show
                    when={layout()[index()]?.timeSeparator}
                  >
                    <ChatTimeSeparator
                      timestamp={message.createdAt}
                    />
                  </Show>
                  <MessageContent
                    data-chat-message={message.id}
                    message={message}
                    joinedPrevious={
                      layout()[index()]?.joinedPrevious
                    }
                    joinedNext={
                      layout()[index()]?.joinedNext
                    }
                    onDelete={() =>
                      messageStores.deleteMessage(
                        message.id,
                      )
                    }
                  />
                </>
              )}
            </For>
          </ul>
        </div>
        <ChatScrollButton
          visible={
            scroll.positioned() && !scroll.following()
          }
          onClick={() => scroll.toBottom()}
          class="right-3 bottom-3 size-9 shadow"
          iconClass="size-5 sm:size-5"
        />
      </div>
      <Show
        when={active()}
        fallback={
          <p
            class="text-muted-foreground shrink-0 border-t p-3 text-center
              text-xs"
          >
            {t("conversations.room_inactive")}
          </p>
        }
      >
        <ChatComposer
          class="static"
          value={draft()}
          onValueChange={setDraft}
          onSendText={(text) => state.sendRoomText(text)}
          onSendFiles={async (files) => {
            const conversationId = props.conversation.id;
            for (const file of files) {
              if (
                state.activeRoomConversationId() !==
                conversationId
              )
                throw new Error(
                  t("conversations.room_inactive"),
                );
              await state.sendRoomFile(file);
            }
          }}
          previewFile={async (file) =>
            Boolean(
              (
                await openPreview(
                  file,
                  props.conversation.title,
                )
              ).result,
            )
          }
          onPaste={(event) => event.stopPropagation()}
          onSent={() => scroll.toBottom()}
          disabled={!canSend()}
          filesDisabled={!canSendFiles()}
          maxLength={ROOM_CHAT_MAX_TEXT_LENGTH}
          inputLabel={t("conversations.room_message")}
          placeholder={t("conversations.room_message")}
          sendLabel={t("conversations.send")}
          sendShortcut="enter"
        />
      </Show>
    </section>
  );
}
