import {
  createMemo,
  createUniqueId,
  For,
  Show,
} from "solid-js";
import { ClientAvatar } from "@/components/common/client-avatar";
import { appState } from "@/libs/state/app-state";
import type { Conversation } from "@/libs/domain/conversation";
import { getRoomMembers } from "@/libs/application/messaging/room-members";
import { t } from "@/i18n";

export function RoomMembersPanel(props: {
  room: Extract<Conversation, { kind: "room" }> | undefined;
  activeRoomId: string | null;
}) {
  const id = createUniqueId();
  const members = createMemo(() =>
    getRoomMembers({
      room: props.room,
      activeRoomId: props.activeRoomId,
      localClient: appState.profile,
      onlineClients: Object.values(
        appState.session.clientViewData,
      ).filter(
        (client) => client?.onlineStatus === "online",
      ),
      clients: appState.message.clients,
      conversations: appState.message.conversations,
      messages: appState.message.messages,
    }),
  );
  return (
    <div class="min-w-0 space-y-5">
      <For each={["online", "previous"] as const}>
        {(group) => (
          <section class="min-w-0 space-y-2">
            <h3
              id={`${id}-${group}`}
              class="flex items-center gap-2 text-sm font-medium"
            >
              {t(
                group === "online"
                  ? "room_dialog.online_members"
                  : "room_dialog.previous_members",
              )}
              <span class="text-muted-foreground tabular-nums">
                {members()[group].length}
              </span>
            </h3>
            <Show
              when={members()[group].length}
              fallback={
                <p class="text-muted-foreground py-2 text-sm">
                  {t(
                    group === "online"
                      ? "room_dialog.members_not_joined"
                      : "room_dialog.no_previous_members",
                  )}
                </p>
              }
            >
              <ul
                aria-labelledby={`${id}-${group}`}
                class="space-y-1"
              >
                <For each={members()[group]}>
                  {(member) => (
                    <li class="flex min-w-0 items-center gap-3 py-2">
                      <ClientAvatar
                        name={member.name}
                        avatar={member.avatar ?? undefined}
                      />
                      <div class="min-w-0 flex-1">
                        <p
                          class="truncate text-sm font-medium"
                          title={member.name}
                        >
                          {member.name}
                          <Show when={member.self}>
                            <span class="text-muted-foreground ml-2 text-xs">
                              {t("meeting.you")}
                            </span>
                          </Show>
                        </p>
                        <p
                          class="text-muted-foreground truncate text-xs"
                          title={member.clientId}
                        >
                          {member.clientId}
                        </p>
                      </div>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </section>
        )}
      </For>
      <p class="text-muted-foreground text-xs">
        {t("room_dialog.members_hint")}
      </p>
    </div>
  );
}
