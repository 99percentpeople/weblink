import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import {
  Component,
  ComponentProps,
  splitProps,
  createMemo,
  Switch,
  Match,
  Show,
} from "solid-js";
import { cn } from "@/libs/cn";
import { A } from "@solidjs/router";
import { Client, ClientInfo } from "@/libs/core/type";
import {
  messageStores,
  StoreMessage,
} from "@/libs/core/message";
import { PortableContextMenu } from "@/components/portable-contextmenu";
import {
  ContextMenuGroup,
  ContextMenuGroupLabel,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu";
import {
  IconAudioFileFilled,
  IconChatBubble,
  IconDelete,
  IconDraftFilled,
  IconFolderMatch,
  IconPhotoFilled,
  IconSettings,
  IconVideoFileFilled,
} from "@/components/icons";

import { createComfirmDeleteClientDialog } from "@/components/dialogs/confirm-delete-client-dialog";
import clientInfoDialog from "@/components/dialogs/client-info-dialog";
import { t } from "@/i18n";
import { createTimeAgo } from "@/libs/utils/timeago";
import { getInitials } from "@/libs/utils/name";
import { ConnectionBadge } from "../../../components/common/connection-badge";
import { IconFile } from "@/components/icon-file";
import { appState } from "@/libs/state/app-state";

export interface UserItemProps extends ComponentProps<"li"> {
  client: Client;
  collapsed: boolean;
  message?: StoreMessage;
}

const MessageData = (props: { message?: StoreMessage }) => {
  switch (props.message?.type) {
    case "text": {
      return (
        <p class="muted line-clamp-2 break-all">
          {props.message.data}
        </p>
      );
    }
    case "file": {
      return (
        <div class="muted line-clamp-2 break-all">
          <div class="space-x-1 [&_*]:inline [&_svg]:size-4 [&>*]:align-middle">
            <IconFile mimetype={props.message.mimeType} />
            <span>{props.message.fileName}</span>
          </div>
        </div>
      );
    }
    default: {
      return <></>;
    }
  }
};

export const UserItem: Component<UserItemProps> = (
  props,
) => {
  const [local] = splitProps(props, [
    "client",
    "collapsed",
    "class",
  ]);

  const clientInfo = createMemo<ClientInfo | undefined>(
    () =>
      appState.session.clientViewData[
        local.client.clientId
      ],
  );

  const { open: openConfirmDeleteClientDialog } =
    createComfirmDeleteClientDialog();
  const { open: openClientInfoDialog } = clientInfoDialog();

  return (
    <PortableContextMenu
      menu={(close) => (
        <ContextMenuGroup>
          <ContextMenuGroupLabel>
            {local.client.name}
          </ContextMenuGroupLabel>
          <ContextMenuSeparator />
          <ContextMenuItem
            as={A}
            href={`/client/${local.client.clientId}/chat`}
            class="gap-2"
            onSelect={() => {
              close();
            }}
          >
            <IconChatBubble class="size-4" />
            {t("client.client_list.context_menu.chat")}
          </ContextMenuItem>
          <ContextMenuItem
            as={A}
            href={`/client/${local.client.clientId}/sync`}
            class="gap-2"
            onSelect={() => {
              close();
            }}
          >
            <IconFolderMatch class="size-4" />
            {t("client.client_list.context_menu.sync")}
          </ContextMenuItem>
          <ContextMenuItem
            class="gap-2"
            onSelect={() => {
              close();
              void openClientInfoDialog(
                local.client.clientId,
              );
            }}
          >
            <IconSettings class="size-4" />
            {t("client.config.open")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            variant="destructive"
            class="gap-2"
            onSelect={async () => {
              close();
              const result = (
                await openConfirmDeleteClientDialog(
                  local.client.name,
                )
              ).result;
              if (!result) return;
              messageStores.deleteClient(
                local.client.clientId,
              );
            }}
          >
            <IconDelete class="size-4" />
            {t("common.action.delete")}
          </ContextMenuItem>
        </ContextMenuGroup>
      )}
    >
      {(p) => (
        <li
          class={cn(
            "hover:bg-muted/50 flex w-full flex-col transition-colors",
          )}
          {...p}
        >
          <A
            class="flex gap-2 px-2 transition-colors hover:cursor-pointer
              sm:px-1"
            href={`/client/${local.client.clientId}/chat`}
          >
            <Avatar class="size-10 self-center">
              <AvatarImage
                src={local.client.avatar ?? undefined}
                alt={local.client.name}
              />
              <AvatarFallback seed={local.client.name}>
                {getInitials(local.client.name)}
              </AvatarFallback>
            </Avatar>
            <Show when={!local.collapsed}>
              <div class="w-full flex-1 space-y-1">
                <p class="flex w-full flex-wrap items-center justify-between gap-2">
                  <span class="line-clamp-1 font-bold text-ellipsis">
                    {props.client.name}
                  </span>
                  <ConnectionBadge client={clientInfo()} />
                </p>
                <MessageData message={props.message} />
                <Show when={props.message?.createdAt}>
                  {(createdAt) => (
                    <span class="muted float-end text-xs text-nowrap">
                      {createTimeAgo(createdAt())}
                    </span>
                  )}
                </Show>
              </div>
            </Show>
          </A>
        </li>
      )}
    </PortableContextMenu>
  );
};
