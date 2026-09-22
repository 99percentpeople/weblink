import { Component } from "solid-js";

import { Button } from "@/components/ui/button";
import { cn } from "@/libs/cn";
import { A } from "@solidjs/router";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { getInitials } from "@/libs/utils/name";
import {
  IconChevronLeft,
  IconFolderMatch,
  IconSettings,
} from "@/components/icons";
import { t } from "@/i18n";
import { ConnectionBadge } from "@/components/common/connection-badge";
import clientInfoDialog from "@/components/dialogs/client-info-dialog";
import type { Client } from "@/libs/domain/client";
import type { ClientInfo } from "@/libs/state/app-state";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
export const ChatHeader: Component<{
  info?: ClientInfo;
  client: Client;
  class?: string;
}> = (props) => {
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
            <Button
              type="button"
              size="icon"
              variant="ghost"
              aria-label={t("client.config.open")}
              onClick={() =>
                void openClientInfoDialog(
                  props.client.clientId,
                )
              }
            >
              <IconSettings class="size-6" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t("client.config.open")}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
};
