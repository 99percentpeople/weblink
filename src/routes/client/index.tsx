import { Component, Match, Show, Switch } from "solid-js";
import { t } from "@/i18n";
import { createRoomDialog } from "@/components/dialogs/join-dialog";
import { useAppState } from "@/libs/state/app-state-context";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/common/spinner";
import {
  IconEditSquare,
  IconLogin,
  IconLogout,
  IconShare,
} from "@/components/icons";
import { createQRCodeDialog } from "@/components/dialogs/create-qrcode-dialog";
import { toast } from "solid-sonner";
import { appState } from "@/libs/state/app-state";
const Client: Component = (props) => {
  const { joinRoom, leaveRoom } = useAppState();
  const { open: openRoomDialog } = createRoomDialog();
  const { open: openQRCodeDialog } = createQRCodeDialog();
  return (
    <div
      class="border-border/50 bg-background/50 absolute top-1/2 left-1/2
        flex max-h-[100vh] w-full max-w-xs -translate-x-1/2
        -translate-y-1/2 flex-col items-stretch gap-2
        overflow-hidden rounded-lg border p-4 backdrop-blur"
    >
      <Switch>
        <Match
          when={
            appState.session.clientServiceStatus ===
            "connected"
          }
        >
          <div class="flex flex-col items-center gap-2">
            <p class="text-xl font-bold">
              {t("client.index.after_join.title", {
                room: appState.roomStatus.roomId,
              })}
            </p>
            <p class="text-muted-foreground text-sm">
              {t("client.index.after_join.description")}
            </p>
          </div>
          <Button
            class="gap-2"
            onClick={() => {
              openQRCodeDialog();
            }}
          >
            <IconShare class="size-6" />
            <span class="w-full text-center">
              {t("client.index.share_room")}
            </span>
          </Button>
          <Button
            variant="outline"
            class="gap-2"
            onClick={() => leaveRoom()}
          >
            <IconLogout class="size-6" />
            <span class="w-full text-center">
              {t("client.index.leave_room")}
            </span>
          </Button>
          <p class="text-muted-foreground text-xs">
            {t("client.index.after_join.tip")}
          </p>
        </Match>
        <Match
          when={
            appState.session.clientServiceStatus ===
            "connecting"
          }
        >
          <div class="flex flex-col items-center gap-2">
            <p class="text-xl font-bold">
              {t("client.index.connecting.title")}
            </p>
            <p class="text-muted-foreground text-sm">
              {t("client.index.connecting.description")}
            </p>
            <Spinner size="lg" />
          </div>
        </Match>
        <Match
          when={
            appState.session.clientServiceStatus ===
            "disconnected"
          }
        >
          <div class="flex flex-col items-center gap-2">
            <p class="text-xl font-bold">
              {t("client.index.before_join.title")}
            </p>
            <p class="text-muted-foreground text-sm">
              {t("client.index.before_join.description")}
            </p>
          </div>
          <Button
            class="gap-2"
            variant="outline"
            onClick={async () => {
              const { result } = await openRoomDialog();
              if (result) {
                joinRoom().catch((e) => {
                  console.error(e);
                  toast.error(e.message);
                });
              }
            }}
          >
            <IconEditSquare class="size-6" />
            <span class="w-full text-center">
              {t(
                appState.profile.initalJoin
                  ? "client.index.setup_room"
                  : "client.index.edit_room",
              )}
            </span>
          </Button>
          <Show when={!appState.profile.initalJoin}>
            <Button
              class="gap-2"
              onClick={() =>
                joinRoom().catch((e) => {
                  console.error(e);
                  toast.error(e.message);
                })
              }
            >
              <IconLogin class="size-6" />
              <span class="w-full text-center">
                {t("client.index.join_room")}
              </span>
            </Button>
          </Show>
        </Match>
      </Switch>
    </div>
  );
};

export default Client;
