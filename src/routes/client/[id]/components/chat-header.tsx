import { Component, Show } from "solid-js";

import { Button } from "@/components/ui/button";
import { cn } from "@/libs/cn";
import { A } from "@solidjs/router";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { messageStores } from "@/libs/core/message";
import { getInitials } from "@/libs/utils/name";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  IconAssignment,
  IconChevronLeft,
  IconConnectWithoutContract,
  IconDataInfoAlert,
  IconDelete,
  IconFolderMatch,
  IconMenu,
} from "@/components/icons";
import { createComfirmDeleteClientDialog } from "@/components/dialogs/confirm-delete-client-dialog";
import { t } from "@/i18n";
import { ConnectionBadge } from "@/components/common/connection-badge";
import { toast } from "solid-sonner";
import { setAppOptions } from "@/options";
import { createClipboardHistoryDialog } from "@/components/dialogs/clipboard-history-dialog";
import clientInfoDialog from "@/components/dialogs/client-info-dialog";
import { ClientInfo, Client } from "@/libs/core/type";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { catchError } from "@/libs/catch";
import { appState } from "@/libs/state/app-state";

export const ChatHeader: Component<{
  info?: ClientInfo;
  client: Client;
  class?: string;
}> = (props) => {
  const { open: openClipboardHistoryDialog } =
    createClipboardHistoryDialog();
  const { open: openConfirmDeleteClientDialog } =
    createComfirmDeleteClientDialog();
  const { open: openClientInfoDialog } = clientInfoDialog();

  return (
    <div class={props.class}>
      <div class="flex w-full items-center gap-2">
        <Button as={A} href="/" size="icon" variant="ghost">
          <IconChevronLeft class="size-8" />
        </Button>

        <Avatar>
          <AvatarImage
            src={props.client.avatar ?? undefined}
          />
          <AvatarFallback seed={props.client.name}>
            {getInitials(props.client.name)}
          </AvatarFallback>
        </Avatar>
        <h4 class={cn("h4")}>{props.client.name}</h4>
        <ConnectionBadge client={props.info} />
        <div class="ml-auto" />
        <Tooltip>
          <TooltipTrigger>
            <Button
              as={A}
              href="../sync"
              variant="ghost"
              size="icon"
            >
              <IconFolderMatch class="size-6" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("client.sync.title")}
          </TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger>
            <DropdownMenu>
              <DropdownMenuTrigger
                as={Button}
                size="icon"
                variant="ghost"
              >
                <IconMenu class="size-6" />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="min-w-48">
                <DropdownMenuGroup>
                  <DropdownMenuGroupLabel>
                    {t("client.menu.options")}
                  </DropdownMenuGroupLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    class="gap-2"
                    onSelect={() => {
                      openClientInfoDialog(
                        props.client.clientId,
                      );
                    }}
                  >
                    <IconDataInfoAlert class="size-4" />
                    {t("client.menu.connection_status")}
                  </DropdownMenuItem>
                  <Show
                    when={
                      props.info?.onlineStatus ===
                        "offline" &&
                      appState.session
                        .clientServiceStatus === "connected"
                    }
                  >
                    <DropdownMenuItem
                      class="gap-2"
                      onSelect={async () => {
                        const session =
                          appState.session.sessions[
                            props.client.clientId
                          ];
                        if (!session) return;
                        const [error] = await catchError(
                          session.reconnect(),
                        );
                        if (error) {
                          toast.error(error.message);
                        }
                      }}
                    >
                      <IconConnectWithoutContract class="size-4" />
                      {t("client.menu.connect")}
                    </DropdownMenuItem>
                  </Show>
                  <Show when={props.info?.clipboard}>
                    {(clipboard) => (
                      <DropdownMenuItem
                        class="gap-2"
                        onSelect={() => {
                          openClipboardHistoryDialog(
                            clipboard,
                          );
                        }}
                      >
                        <IconAssignment class="size-4" />
                        {t("client.menu.clipboard")}
                      </DropdownMenuItem>
                    )}
                  </Show>

                  <DropdownMenuItem
                    class="gap-2"
                    onSelect={async () => {
                      const result = (
                        await openConfirmDeleteClientDialog(
                          props.client.name,
                        )
                      ).result;
                      if (!result) return;
                      messageStores.deleteClient(
                        props.client.clientId,
                      );
                    }}
                  >
                    <IconDelete class="size-4" />
                    {t("client.menu.delete_client")}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuGroup>
                    <DropdownMenuCheckboxItem
                      class="gap-2"
                      checked={
                        appState.options
                          .redirectToClient ===
                        props.client.clientId
                      }
                      onChange={(checked) => {
                        setAppOptions(
                          "redirectToClient",
                          checked
                            ? props.client.clientId
                            : undefined,
                        );
                      }}
                    >
                      {t("client.menu.redirect")}
                    </DropdownMenuCheckboxItem>
                  </DropdownMenuGroup>
                </DropdownMenuGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </TooltipTrigger>
          <TooltipContent>
            {t("client.menu.options")}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};
