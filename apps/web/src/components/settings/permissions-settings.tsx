import {
  For,
  Show,
  createMemo,
  createSignal,
} from "solid-js";
import { Settings2, Trash2 } from "lucide-solid";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import {
  forgetClientConfig,
  forgetRoomConfig,
} from "@/options";
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

type Entry = { kind: "client" | "room"; id: string };
export default function PermissionsSettings() {
  const state = useAppState();
  const [selected, setSelected] = createSignal<Entry>();
  const [forgetting, setForgetting] = createSignal<Entry>();
  const entries = createMemo(() => [
    ...Object.keys(appState.options.clientConfigs)
      .filter((id) => appState.options.clientConfigs[id])
      .map((id): Entry => ({ kind: "client", id })),
    ...Object.keys(appState.options.roomConfigs)
      .filter((id) => appState.options.roomConfigs[id])
      .map((id): Entry => ({ kind: "room", id })),
  ]);
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
  const present = (entry: Entry) =>
    entry.kind === "client"
      ? !!appState.session.clientViewData[entry.id]
      : state.activeRoomConversationId() === entry.id;
  const confirmForget = () => {
    const entry = forgetting();
    if (!entry) return;
    if (entry.kind === "client")
      forgetClientConfig(entry.id);
    else
      forgetRoomConfig(
        entry.id,
        state.activeRoomConversationId(),
      );
    setForgetting(undefined);
  };
  return (
    <>
      <section
        class="settings-section"
        aria-labelledby="permissions-settings"
      >
        <h3 id="permissions-settings" class="h3">
          {t("app_menu.settings_permissions")}
        </h3>
        <p class="muted">
          {t("setting.permissions.description")}
        </p>
        <For each={["client", "room"] as const}>
          {(kind) => (
            <>
              <h3 class="h3">
                {t(
                  `setting.permissions.${kind === "client" ? "clients" : "rooms"}`,
                )}
              </h3>
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
                <div class="divide-y rounded-lg border px-3">
                  <For
                    each={entries().filter(
                      (entry) => entry.kind === kind,
                    )}
                  >
                    {(entry) => (
                      <div class="flex items-center gap-2 py-3">
                        <div class="min-w-0 flex-1">
                          <p class="truncate font-medium">
                            {name(entry)}
                          </p>
                          <p
                            class="text-muted-foreground truncate text-xs"
                            title={entry.id}
                          >
                            {entry.kind === "client"
                              ? t(
                                  `setting.permissions.${appState.options.clientConfigs[entry.id]?.remoteControl ?? "ask"}`,
                                )
                              : entry.id}
                          </p>
                        </div>
                        <Button
                          variant="ghost"
                          size="icon"
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
                          aria-label={t(
                            present(entry)
                              ? "setting.permissions.reset"
                              : "setting.permissions.remove",
                            { name: name(entry) },
                          )}
                          onClick={() =>
                            setForgetting(entry)
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
      </section>
      <Dialog
        open={!!forgetting()}
        onOpenChange={(open) => {
          if (!open) setForgetting(undefined);
        }}
      >
        <DialogContent>
          <Show when={forgetting()}>
            {(entry) => (
              <>
                <DialogHeader>
                  <DialogTitle>
                    {t(
                      present(entry())
                        ? "setting.permissions.reset_title"
                        : "setting.permissions.forget_title",
                    )}
                  </DialogTitle>
                  <DialogDescription>
                    {t(
                      present(entry())
                        ? "setting.permissions.reset_description"
                        : "setting.permissions.forget_description",
                      { name: name(entry()) },
                    )}
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <Button
                    variant="outline"
                    onClick={() => setForgetting(undefined)}
                  >
                    {t("common.action.cancel")}
                  </Button>
                  <Button
                    variant="destructive"
                    onClick={confirmForget}
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
                      />
                    }
                  >
                    <ClientPermissions
                      clientId={entry().id}
                    />
                  </Show>
                </DialogBody>
              </>
            )}
          </Show>
        </DialogContent>
      </Dialog>
    </>
  );
}
