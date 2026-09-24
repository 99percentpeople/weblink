import { sharedFilesHref } from "@/libs/application/home-navigation";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  Show,
} from "solid-js";
import { makePersisted } from "@solid-primitives/storage";
import { A } from "@solidjs/router";
import {
  Search,
  ListFilter,
  ChevronDown,
  ChevronRight,
  MoreHorizontal,
  Users,
  MessageCircle,
  FolderSync,
  Settings,
  Trash2,
  Eraser,
  PanelLeftOpen,
} from "lucide-solid";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ClientAvatar } from "@/components/common/client-avatar";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import { messageStores } from "@/libs/application/messaging/message-store";
import {
  filterConversations,
  groupConversations,
  summarizeConversations,
  type ConversationFilter,
  type ConversationSummary,
} from "@/libs/application/messaging/conversation-query";
import { createConversationActions } from "./conversation-actions";
import { createRoomInfoDialog } from "@/components/dialogs/room-info-dialog";
import clientInfoDialog from "@/components/dialogs/client-info-dialog";
import { LabelEditor } from "./label-editor";
import { cn } from "@/libs/cn";
import { t } from "@/i18n";

export interface ConversationSidebarProps {
  selectedId?: string;
  onSelect(id: string): void;
  collapsed?: boolean;
  onExpand?: () => void;
}

export function ConversationSidebar(
  props: ConversationSidebarProps,
) {
  const { activeRoomConversationId } = useAppState();
  const [query, setQuery] = makePersisted(
    createSignal(""),
    {
      storage: sessionStorage,
      name: "conversation-search",
    },
  );
  const [filter, setFilter] = makePersisted(
    createSignal<ConversationFilter>("all"),
    {
      storage: sessionStorage,
      name: "conversation-filter",
    },
  );
  const [selectedLabels, setSelectedLabels] = makePersisted(
    createSignal<string[]>([]),
    {
      storage: sessionStorage,
      name: "conversation-label-filter",
    },
  );
  const [grouped, setGrouped] = makePersisted(
    createSignal(false),
    {
      storage: sessionStorage,
      name: "conversation-grouped",
    },
  );
  const [closedGroups, setClosedGroups] = makePersisted(
    createSignal<string[]>([]),
    {
      storage: sessionStorage,
      name: "conversation-closed-groups",
    },
  );
  const { open: showClientInfo } = clientInfoDialog();
  const { open: showRoomInfo } = createRoomInfoDialog();
  createEffect(() => {
    if (appState.message.status !== "ready") return;
    const valid = new Set(
      appState.message.labels.map((label) => label.id),
    );
    setSelectedLabels((ids) =>
      ids.filter((id) => valid.has(id)),
    );
  });
  const summaries = createMemo(() =>
    summarizeConversations(
      appState.message.conversations,
      appState.message.clients,
      appState.message.messages,
      appState.profile.clientId,
      new Set(
        Object.values(appState.session.clientViewData)
          .filter(
            (client) => client?.onlineStatus === "online",
          )
          .map((client) => client.clientId),
      ),
      activeRoomConversationId(),
    ),
  );
  const filtered = createMemo(() =>
    filterConversations(
      summaries(),
      query(),
      selectedLabels(),
      filter(),
      appState.message.labels,
    ),
  );
  const byId = createMemo(
    () =>
      new Map(
        summaries().map((summary) => [
          summary.conversation.id,
          summary,
        ]),
      ),
  );
  const groups = createMemo(() =>
    groupConversations(filtered(), appState.message.labels),
  );
  const unread = createMemo(() =>
    summaries().reduce(
      (sum, summary) => sum + summary.unread,
      0,
    ),
  );
  const toggleLabel = (id: string) =>
    setSelectedLabels((ids) =>
      ids.includes(id)
        ? ids.filter((value) => value !== id)
        : [...ids, id],
    );
  const actions = createConversationActions(
    (id) => byId().get(id)?.online ?? false,
  );
  const Row = (row: { summary: ConversationSummary }) => {
    const conversation = () => row.summary.conversation;
    return (
      <li
        data-conversation-id={conversation().id}
        class={cn(
          `group flex min-w-0 items-center gap-1 rounded-xl px-1
          transition-colors`,
          props.selectedId === conversation().id
            ? "bg-primary/10"
            : "hover:bg-muted/60",
        )}
      >
        <button
          type="button"
          class="focus-visible:ring-ring flex min-w-0 flex-1 items-center
            gap-3 rounded-xl p-2 text-left outline-none
            focus-visible:ring-2"
          aria-current={
            props.selectedId === conversation().id
              ? "true"
              : undefined
          }
          title={row.summary.title}
          onClick={() => props.onSelect(conversation().id)}
        >
          <span class="relative shrink-0">
            <Show
              when={conversation().kind === "room"}
              fallback={
                <ClientAvatar
                  class="size-10"
                  name={row.summary.title}
                  avatar={row.summary.avatar}
                />
              }
            >
              <span
                class="bg-primary/10 text-primary flex size-10 items-center
                  justify-center rounded-full"
              >
                <Users class="size-5" />
              </span>
            </Show>
            <Show when={row.summary.online}>
              <span
                class="border-background absolute right-0 bottom-0 size-2.5
                  rounded-full border-2 bg-emerald-500"
                aria-label={t("conversations.online")}
              />
            </Show>
          </span>
          <Show when={!props.collapsed}>
            <span class="min-w-0 flex-1 space-y-1">
              <span class="flex items-center gap-2">
                <span class="min-w-0 flex-1 truncate text-sm font-semibold">
                  {row.summary.title}
                </span>
                <Show when={row.summary.unread}>
                  <span
                    class="bg-primary text-primary-foreground rounded-full px-2
                      text-[10px] leading-5"
                    aria-label={t(
                      "conversations.unread_count",
                      { count: row.summary.unread },
                    )}
                  >
                    {row.summary.unread > 99
                      ? "99+"
                      : row.summary.unread}
                  </span>
                </Show>
              </span>
              <span class="text-muted-foreground block truncate text-xs">
                {row.summary.preview ||
                  t(
                    row.summary.active
                      ? "conversations.current_room"
                      : "conversations.no_messages",
                  )}
              </span>
              <Show when={conversation().labelIds.length}>
                <span class="flex gap-1 overflow-hidden">
                  <For
                    each={appState.message.labels.filter(
                      (label) =>
                        conversation().labelIds.includes(
                          label.id,
                        ),
                    )}
                  >
                    {(label) => (
                      <span
                        class="bg-muted text-muted-foreground max-w-24 truncate rounded
                          px-1.5 py-0.5 text-[10px]"
                      >
                        {label.name}
                      </span>
                    )}
                  </For>
                </span>
              </Show>
            </span>
          </Show>
        </button>
        <Show when={!props.collapsed}>
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger
              as={Button}
              variant="ghost"
              size="icon"
              class="size-7 shrink-0"
              aria-label={t("conversations.actions", {
                name: row.summary.title,
              })}
            >
              <MoreHorizontal class="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent class="max-h-80 w-52 overflow-y-auto">
              <p class="text-muted-foreground px-2 py-1.5 text-xs">
                {t("conversations.labels")}
              </p>
              <For
                each={appState.message.labels}
                fallback={
                  <p class="text-muted-foreground px-2 py-1.5 text-xs">
                    {t("conversations.no_labels")}
                  </p>
                }
              >
                {(label) => (
                  <DropdownMenuCheckboxItem
                    checked={conversation().labelIds.includes(
                      label.id,
                    )}
                    onChange={(checked) =>
                      messageStores.setConversationLabels(
                        conversation().id,
                        checked
                          ? [
                              ...conversation().labelIds,
                              label.id,
                            ]
                          : conversation().labelIds.filter(
                              (id) => id !== label.id,
                            ),
                      )
                    }
                  >
                    {label.name}
                  </DropdownMenuCheckboxItem>
                )}
              </For>
              <Show when={conversation().kind === "room"}>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  class="gap-2"
                  onSelect={() =>
                    void showRoomInfo(conversation().id)
                  }
                >
                  <Settings class="size-4" />
                  {t("room_dialog.open")}
                </DropdownMenuItem>
              </Show>
              <Show
                when={
                  conversation().kind === "direct" &&
                  conversation()
                }
              >
                {(direct) => {
                  const peer = () => {
                    const value = direct();
                    return value.kind === "direct"
                      ? value.peerId
                      : "";
                  };
                  return (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        as={A}
                        href={sharedFilesHref(peer())}
                        class="gap-2"
                      >
                        <FolderSync class="size-4" />
                        {t("client.sync.title")}
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        class="gap-2"
                        onSelect={() =>
                          void showClientInfo(
                            peer(),
                            "session",
                            conversation().id,
                          )
                        }
                      >
                        <Settings class="size-4" />
                        {t("client.config.open")}
                      </DropdownMenuItem>
                    </>
                  );
                }}
              </Show>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                class="gap-2"
                disabled={actions.busy()}
                onSelect={() =>
                  void actions.clear(conversation().id)
                }
              >
                <Eraser class="size-4" />
                {t("conversations.clear")}
              </DropdownMenuItem>
              <DropdownMenuItem
                variant="destructive"
                class="gap-2"
                disabled={
                  actions.busy() || row.summary.online
                }
                onSelect={() =>
                  void actions.remove(conversation().id)
                }
              >
                <Trash2 class="size-4" />
                {t("conversations.delete")}
              </DropdownMenuItem>
              <Show when={row.summary.online}>
                <p class="text-muted-foreground px-2 py-1.5 text-xs">
                  {t("conversations.delete_requires_exit")}
                </p>
              </Show>
            </DropdownMenuContent>
          </DropdownMenu>
        </Show>
      </li>
    );
  };

  const Rows = (rows: {
    items: readonly ConversationSummary[];
  }) => (
    <For
      each={rows.items.map(
        (summary) => summary.conversation.id,
      )}
    >
      {(id) => (
        <Show when={byId().get(id)}>
          {(summary) => <Row summary={summary()} />}
        </Show>
      )}
    </For>
  );
  const Group = (props: { id: string }) => {
    const group = createMemo(() =>
      groups().find((item) => item.id === props.id),
    );
    return (
      <Show when={group()}>
        {(current) => (
          <section class="mb-3">
            <button
              type="button"
              class="text-muted-foreground flex w-full items-center gap-1 px-2
                py-2 text-left text-xs font-medium"
              aria-expanded={
                !closedGroups().includes(props.id)
              }
              onClick={() =>
                setClosedGroups((ids) =>
                  ids.includes(props.id)
                    ? ids.filter((id) => id !== props.id)
                    : [...ids, props.id],
                )
              }
            >
              <Show
                when={closedGroups().includes(props.id)}
                fallback={<ChevronDown class="size-3.5" />}
              >
                <ChevronRight class="size-3.5" />
              </Show>
              <span class="min-w-0 flex-1 truncate">
                {current().name ||
                  t("conversations.unlabelled")}
              </span>
              <span>{current().items.length}</span>
            </button>
            <Show when={!closedGroups().includes(props.id)}>
              <ul class="space-y-1">
                <Rows items={current().items} />
              </ul>
            </Show>
          </section>
        )}
      </Show>
    );
  };

  return (
    <aside
      data-slot="conversation-sidebar"
      class="flex h-full min-h-0 w-full flex-col overflow-hidden"
    >
      <Show
        when={!props.collapsed}
        fallback={
          <Button
            class="m-1"
            variant="ghost"
            size="icon"
            aria-label={t("conversations.expand")}
            onClick={props.onExpand}
          >
            <PanelLeftOpen class="size-4" />
          </Button>
        }
      >
        <div class="shrink-0 space-y-3 border-b p-3">
          <div class="flex items-center gap-2">
            <MessageCircle class="text-primary size-5" />
            <h2 class="flex-1 text-sm font-semibold">
              {t("conversations.title")}
            </h2>
            <Show when={unread()}>
              <span class="text-muted-foreground text-xs">
                {unread()}
              </span>
            </Show>
            <LabelEditor />
            <Button
              variant={grouped() ? "secondary" : "ghost"}
              size="icon"
              class="size-8"
              aria-label={t("conversations.group_by_label")}
              aria-pressed={grouped()}
              onClick={() => setGrouped(!grouped())}
            >
              <ListFilter class="size-4" />
            </Button>
          </div>
          <div class="relative">
            <Search
              class="text-muted-foreground pointer-events-none absolute top-2.5
                left-2.5 size-4"
            />
            <Input
              class="h-9 pl-8"
              value={query()}
              onInput={(event) =>
                setQuery(event.currentTarget.value)
              }
              placeholder={t("conversations.search")}
              aria-label={t("conversations.search")}
            />
          </div>
          <div class="flex flex-wrap gap-1">
            <For
              each={
                ["all", "unread", "direct", "room"] as const
              }
            >
              {(value) => (
                <button
                  type="button"
                  class={cn(
                    "rounded-full px-2.5 py-1 text-xs transition-colors",
                    filter() === value
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/60 text-muted-foreground hover:bg-muted",
                  )}
                  aria-pressed={filter() === value}
                  onClick={() => setFilter(value)}
                >
                  {t(`conversations.filter_${value}`)}
                </button>
              )}
            </For>
          </div>
          <Show when={appState.message.labels.length}>
            <div
              class="flex flex-wrap gap-1"
              aria-label={t("conversations.filter_labels")}
            >
              <For each={appState.message.labels}>
                {(label) => (
                  <button
                    type="button"
                    class={cn(
                      "max-w-full truncate rounded-md border px-2 py-0.5 text-xs",
                      selectedLabels().includes(label.id)
                        ? "border-primary bg-primary/10 text-primary"
                        : "text-muted-foreground border-border",
                    )}
                    aria-pressed={selectedLabels().includes(
                      label.id,
                    )}
                    onClick={() => toggleLabel(label.id)}
                  >
                    {label.name}
                  </button>
                )}
              </For>
            </div>
          </Show>
        </div>
      </Show>
      <div class="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-1.5">
        <Show
          when={filtered().length}
          fallback={
            <p class="text-muted-foreground px-3 py-8 text-center text-sm">
              {t("conversations.empty")}
            </p>
          }
        >
          <Show
            when={grouped() && !props.collapsed}
            fallback={
              <ul class="space-y-1">
                <Rows items={filtered()} />
              </ul>
            }
          >
            <For each={groups().map((group) => group.id)}>
              {(id) => <Group id={id} />}
            </For>
          </Show>
        </Show>
      </div>
    </aside>
  );
}
