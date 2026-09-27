import { Show } from "solid-js";
import {
  Folder,
  Link,
  ListTodo,
  QrCode,
  Settings,
} from "lucide-solid";
import { toast } from "solid-sonner";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { createQRCodeDialog } from "@/components/dialogs/create-qrcode-dialog";
import { joinUrl } from "@/components/dialogs/join-dialog";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import { getInitials } from "@/libs/utils/name";
import { useAppDialogs } from "./app-dialogs";
import { t } from "@/i18n";

export function AccountMenu() {
  const dialogs = useAppDialogs();
  const state = useAppState();
  const qr = createQRCodeDialog();
  // Open only after the menu releases its focus scope and dismissable layer.
  let pendingAction: (() => unknown) | undefined;
  const open = (action: () => unknown) => {
    pendingAction = action;
  };
  const copyLink = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl());
      toast.success(
        t("common.notification.link_copy_success"),
      );
    } catch {
      toast.error(
        t("common.notification.link_copy_failed"),
      );
    }
  };
  return (
    <DropdownMenu placement="bottom-end">
      <DropdownMenuTrigger
        class="account-menu-trigger"
        aria-label={t("app_menu.title")}
      >
        <Avatar class="size-9">
          <AvatarImage
            src={appState.profile.avatar ?? undefined}
          />
          <AvatarFallback seed={appState.profile.name}>
            {getInitials(appState.profile.name)}
          </AvatarFallback>
        </Avatar>
        <Show when={state.tasks.activeCount() > 0}>
          <span class="account-task-dot" />
        </Show>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        class="w-64"
        onCloseAutoFocus={(event) => {
          const action = pendingAction;
          pendingAction = undefined;
          if (!action) return;
          event.preventDefault();
          queueMicrotask(() => {
            void action();
          });
        }}
      >
        <div class="flex min-w-0 flex-col gap-1 px-3 py-2">
          <strong class="truncate text-sm">
            {appState.profile.name}
          </strong>
          <span
            class="text-muted-foreground truncate text-xs"
            title={appState.profile.clientId}
          >
            {appState.profile.clientId}
          </span>
          <Show when={appState.roomStatus.roomId}>
            <span class="text-muted-foreground truncate text-xs">
              {appState.roomStatus.roomId}
            </span>
          </Show>
        </div>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onPointerEnter={dialogs.preloadFiles}
          onFocus={dialogs.preloadFiles}
          onPointerDown={dialogs.preloadFiles}
          onSelect={() => {
            dialogs.preloadFiles();
            open(dialogs.openFiles);
          }}
        >
          <Folder />
          {t("cache.title")}
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => open(dialogs.openTasks)}
        >
          <ListTodo />
          {t("tasks.title")}
          <Show when={state.tasks.activeCount() > 0}>
            <span
              class="bg-primary/15 text-primary ml-auto rounded-full px-2 text-xs
                tabular-nums"
            >
              {state.tasks.activeCount()}
            </span>
          </Show>
        </DropdownMenuItem>
        <DropdownMenuItem
          onPointerEnter={dialogs.preloadSettings}
          onFocus={dialogs.preloadSettings}
          onPointerDown={dialogs.preloadSettings}
          onSelect={() => {
            dialogs.preloadSettings();
            open(() => dialogs.openSettings());
          }}
        >
          <Settings />
          {t("common.nav.settings")}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void copyLink();
          }}
        >
          <Link />
          {t("common.nav.share_link")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => open(qr.open)}>
          <QrCode />
          {t("app_menu.room_qrcode")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
