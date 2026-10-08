import { resolvedLocale } from "@/libs/state/app-locale";
import {
  SettingSection,
  SettingHeading,
} from "./setting-layout";
import {
  For,
  Show,
  createMemo,
  createSignal,
} from "solid-js";
import { RotateCcw, Settings2, Trash2 } from "lucide-solid";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import {
  forgetClientConfig,
  resetClientConfig,
  resetRoomConfig,
} from "@/options";
import { deleteRoomRecord } from "@/libs/state/delete-conversation-record";
import { getConversationUpdateTimes } from "@/libs/application/messaging/conversation-activity";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RoomPermissions } from "@/components/dialogs/room-settings";
import { ClientPermissions } from "./client-permissions";

type Entry = {
  kind: "client" | "room";
  id: string;
  updatedAt: number;
};
export default function PermissionsSettings() {
  const state = useAppState();
  const [selected, setSelected] = createSignal<Entry>();
  const [deleting, setDeleting] = createSignal<Entry>();
  const entries = createMemo(() => {
    const times = getConversationUpdateTimes(
      appState.message.conversations,
      appState.message.messages,
    );
    const clientTimes = new Map<string, number>();
    for (const conversation of appState.message
      .conversations) {
      if (conversation.kind === "direct")
        clientTimes.set(
          conversation.peerId,
          Math.max(
            clientTimes.get(conversation.peerId) ?? 0,
            times.get(conversation.id) ?? 0,
          ),
        );
    }
    return [
      ...Object.keys(appState.options.clientConfigs)
        .filter((id) => appState.options.clientConfigs[id])
        .map(
          (id): Entry => ({
            kind: "client",
            id,
            updatedAt: clientTimes.get(id) ?? 0,
          }),
        ),
      ...Object.keys(appState.options.roomConfigs)
        .filter((id) => appState.options.roomConfigs[id])
        .map(
          (id): Entry => ({
            kind: "room",
            id,
            updatedAt: times.get(id) ?? 0,
          }),
        ),
    ].sort(
      (a, b) =>
        b.updatedAt - a.updatedAt ||
        a.id.localeCompare(b.id),
    );
  });
  const name = (entry: Entry) =>
    entry.kind === "client"
      ? (appState.session.clientViewData[entry.id]?.name ??
        appState.options.clientConfigs[entry.id]?.name ??
        appState.message.clients.find(
          (client) => client.clientId === entry.id,
        )?.name ??
        entry.id)
      : (appState.message.conversations.find(
          (room) => room.id === entry.id,
        )?.title ??
        appState.options.roomConfigs[entry.id]?.name ??
        entry.id);
  const timestamp = (entry: Entry) => {
    if (!entry.updatedAt) return;
    const date = new Date(entry.updatedAt);
    return {
      dateTime: date.toISOString(),
      label: t("setting.permissions.last_updated", {
        time: date.toLocaleString(resolvedLocale(), {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
        }),
      }),
    };
  };
  const present = (entry: Entry) =>
    entry.kind === "client"
      ? !!appState.session.clientViewData[entry.id]
      : state.activeRoomConversationId() === entry.id;
  const canDelete = (entry: Entry) =>
    !present(entry) &&
    (entry.kind === "client" ||
      appState.message.status === "ready");
  const deleteLabel = (entry: Entry) =>
    t(
      entry.kind === "room"
        ? "setting.permissions.delete_room"
        : "setting.permissions.remove",
      { name: name(entry) },
    );
  const confirmDelete = () => {
    const entry = deleting();
    if (!entry || !canDelete(entry)) return;
    if (entry.kind === "client")
      forgetClientConfig(entry.id);
    else deleteRoomRecord(entry.id);
    setDeleting(undefined);
  };
  const reset = (entry: Entry) => {
    if (entry.kind === "client")
      resetClientConfig(entry.id);
    else resetRoomConfig(entry.id);
  };
  return (
    <>
      <SettingSection
        title={t("app_menu.settings_permissions")}
        id="permissions-settings"
        class="@container"
        description={t("setting.permissions.description")}
      >
        <For each={["client", "room"] as const}>
          {(kind) => (
            <>
              <SettingHeading>
                {t(
                  `setting.permissions.${kind === "client" ? "clients" : "rooms"}`,
                )}
              </SettingHeading>
              <Show
                when={entries().some(
                  (entry) => entry.kind === kind,
                )}
                fallback={
                  <p class="muted">
                    {t(
                      `setting.permissions.empty_${kind === "client" ? "clients" : "rooms"}`,
                    )}
                  </p>
                }
              >
                <div
                  class="@md:grid-cols-[minmax(0,1fr)_max-content_2rem_2rem] grid
                    grid-cols-[minmax(0,1fr)_2rem_2rem] gap-x-2 divide-y
                    rounded-lg border px-2.5"
                >
                  <For
                    each={entries().filter(
                      (entry) => entry.kind === kind,
                    )}
                  >
                    {(entry) => (
                      <div class="col-span-full grid grid-cols-subgrid items-center py-1.5">
                        <p
                          class="col-start-1 row-start-1 min-w-0 break-words text-sm
                            font-medium leading-5"
                          title={name(entry)}
                        >
                          {name(entry)}
                        </p>
                        <Show when={timestamp(entry)}>
                          {(timestamp) => (
                            <time
                              class="text-muted-foreground @md:col-start-2 @md:row-start-1
                                col-start-1 row-start-2 min-w-0 text-[11px] tabular-nums
                                leading-5"
                              dateTime={
                                timestamp().dateTime
                              }
                              title={timestamp().label}
                            >
                              {timestamp().label}
                            </time>
                          )}
                        </Show>
                        <Button
                          variant="ghost"
                          size="icon"
                          class="@md:col-start-3 @md:row-span-1 col-start-2 row-span-2
                            row-start-1 size-8"
                          aria-label={t(
                            "setting.permissions.configure",
                            { name: name(entry) },
                          )}
                          onClick={() => setSelected(entry)}
                        >
                          <Settings2 class="size-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          class="@md:col-start-4 @md:row-span-1 col-start-3 row-span-2
                            row-start-1 size-8"
                          disabled={!canDelete(entry)}
                          aria-label={deleteLabel(entry)}
                          title={
                            present(entry)
                              ? t(
                                  entry.kind === "room"
                                    ? "conversations.delete_requires_exit"
                                    : "setting.permissions.delete_requires_disconnect",
                                )
                              : deleteLabel(entry)
                          }
                          onClick={() =>
                            canDelete(entry) &&
                            setDeleting(entry)
                          }
                        >
                          <Trash2 class="size-4" />
                        </Button>
                      </div>
                    )}
                  </For>
                </div>
              </Show>
            </>
          )}
        </For>
      </SettingSection>
      <Dialog
        open={!!deleting()}
        onOpenChange={(open) => {
          if (!open) setDeleting(undefined);
        }}
      >
        <DialogContent>
          <Show when={deleting()}>
            {(entry) => (
              <>
                <DialogHeader>
                  <DialogTitle>
                    {t(
                      entry().kind === "room"
                        ? "conversations.delete_room"
                        : "setting.permissions.remove_title",
                    )}
                  </DialogTitle>
                  <DialogDescription>
                    {t(
                      entry().kind === "room"
                        ? "conversations.delete_room_description"
                        : "setting.permissions.remove_description",
                      { name: name(entry()) },
                    )}
                  </DialogDescription>
                </DialogHeader>
                <Show when={present(entry())}>
                  <p
                    class="text-muted-foreground text-sm"
                    role="status"
                  >
                    {t(
                      entry().kind === "room"
                        ? "conversations.delete_requires_exit"
                        : "setting.permissions.delete_requires_disconnect",
                    )}
                  </p>
                </Show>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setDeleting(undefined)}
                  >
                    {t("common.action.cancel")}
                  </Button>
                  <Button
                    variant="destructive"
                    disabled={!canDelete(entry())}
                    onClick={confirmDelete}
                  >
                    {t("common.action.confirm")}
                  </Button>
                </DialogFooter>
              </>
            )}
          </Show>
        </DialogContent>
      </Dialog>
      <Dialog
        open={!!selected()}
        onOpenChange={(open) => {
          if (!open) setSelected(undefined);
        }}
      >
        <DialogContent>
          <Show when={selected()}>
            {(entry) => (
              <>
                <DialogHeader>
                  <DialogTitle>{name(entry())}</DialogTitle>
                  <DialogDescription class="break-all">
                    {entry().id}
                  </DialogDescription>
                </DialogHeader>
                <DialogBody>
                  <Show
                    when={entry().kind === "client"}
                    fallback={
                      <RoomPermissions
                        conversationId={entry().id}
                        control="select"
                      />
                    }
                  >
                    <ClientPermissions
                      clientId={entry().id}
                    />
                  </Show>
                </DialogBody>
                <p class="text-muted-foreground text-xs">
                  {t(
                    "setting.permissions.reset_description",
                  )}
                </p>
                <DialogFooter>
                  <Button
                    variant="outline"
                    aria-label={t(
                      "setting.permissions.reset",
                      {
                        name: name(entry()),
                      },
                    )}
                    onClick={() => reset(entry())}
                  >
                    <RotateCcw class="size-4" />
                    {t("setting.permissions.reset_action")}
                  </Button>
                </DialogFooter>
              </>
            )}
          </Show>
        </DialogContent>
      </Dialog>
    </>
  );
}
