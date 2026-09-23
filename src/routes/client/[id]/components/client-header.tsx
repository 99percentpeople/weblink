import { conversationHref } from "@/libs/application/home-navigation";
import { directConversationId } from "@/libs/domain/conversation";
import { appState } from "@/libs/state/app-state";
import {
  Show,
  type Component,
  type ComponentProps,
} from "solid-js";
import { A } from "@solidjs/router";
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
} from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  IconChatBubble,
  IconChevronLeft,
  IconFolderMatch,
  IconSettings,
} from "@/components/icons";
import { ConnectionBadge } from "@/components/common/connection-badge";
import clientInfoDialog from "@/components/dialogs/client-info-dialog";
import { t } from "@/i18n";
import type { Client } from "@/libs/domain/client";
import type { ClientID } from "@/libs/domain/ids";
import type { ClientInfo } from "@/libs/state/app-state";
import { getInitials } from "@/libs/utils/name";
import { cn } from "@/libs/cn";
import { ConversationBackButton } from "@/components/conversations/conversation-back-button";

const HeaderLink: Component<ComponentProps<typeof A>> = (
  props,
) => (
  <Button as={A} variant="ghost" size="icon" {...props} />
);

export const ClientHeader: Component<{
  clientId: ClientID;
  conversationId?: string;
  client?: Client;
  info?: ClientInfo;
  view: "chat" | "sync";
  class?: string;
  embedded?: boolean;
  onBack?: () => void;
}> = (props) => {
  const { open: openClientInfoDialog } = clientInfoDialog();
  const client = () => props.client ?? props.info;
  const name = () => client()?.name ?? props.clientId;
  const isChat = () => props.view === "chat";
  const destination = () =>
    isChat()
      ? `/client/${encodeURIComponent(props.clientId)}/sync`
      : conversationHref(
          directConversationId(
            appState.profile.clientId,
            props.clientId,
          ),
        );
  const destinationLabel = () =>
    isChat()
      ? t("client.sync.title")
      : t("client.sync.menu.chat");

  return (
    <header
      data-slot="client-header"
      class={cn(
        `border-border bg-background/80 sticky
        top-(--mobile-header-height) z-10 flex w-full shrink-0
        items-center gap-2 border-b p-2 backdrop-blur md:top-0`,
        props.class,
      )}
    >
      <Show when={props.onBack}>
        {(onBack) => (
          <ConversationBackButton onClick={onBack()} />
        )}
      </Show>
      <Show when={!props.embedded && !props.onBack}>
        <Button
          as={A}
          href="/"
          size="icon"
          variant="ghost"
          aria-label={t("404.home")}
        >
          <IconChevronLeft class="size-8" />
        </Button>
      </Show>
      <Avatar>
        <AvatarImage src={client()?.avatar ?? undefined} />
        <AvatarFallback seed={name()}>
          {getInitials(name())}
        </AvatarFallback>
      </Avatar>
      <div class="flex min-w-0 items-center gap-2">
        <h4 class="h4 min-w-0 truncate" title={name()}>
          {name()}
        </h4>
        <div class="shrink-0">
          <ConnectionBadge client={props.info} />
        </div>
      </div>
      <div class="ml-auto flex shrink-0 items-center gap-2">
        <Show when={!props.embedded}>
          <Tooltip>
            <TooltipTrigger
              as={HeaderLink}
              href={destination()}
              aria-label={destinationLabel()}
            >
              <Show
                when={isChat()}
                fallback={<IconChatBubble class="size-6" />}
              >
                <IconFolderMatch class="size-6" />
              </Show>
            </TooltipTrigger>
            <TooltipContent>
              {destinationLabel()}
            </TooltipContent>
          </Tooltip>
        </Show>
        <Tooltip>
          <TooltipTrigger
            as={Button}
            type="button"
            size="icon"
            variant="ghost"
            aria-label={t("client.config.open")}
            onClick={() =>
              void openClientInfoDialog(
                props.clientId,
                "session",
                props.conversationId,
              )
            }
          >
            <IconSettings class="size-6" />
          </TooltipTrigger>
          <TooltipContent>
            {t("client.config.open")}
          </TooltipContent>
        </Tooltip>
      </div>
    </header>
  );
};
