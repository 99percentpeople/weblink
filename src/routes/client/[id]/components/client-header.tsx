import { conversationHref } from "@/libs/application/home-navigation";
import { directConversationId } from "@/libs/domain/conversation";
import { appState } from "@/libs/state/app-state";
import {
  Show,
  type Component,
  type ComponentProps,
} from "solid-js";
import { A } from "@solidjs/router";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  IconChatBubble,
  IconFolderMatch,
  IconSettings,
} from "@/components/icons";
import clientInfoDialog from "@/components/dialogs/client-info-dialog";
import { t } from "@/i18n";
import type { Client } from "@/libs/domain/client";
import type { ClientID } from "@/libs/domain/ids";
import type { ClientInfo } from "@/libs/state/app-state";
import { cn } from "@/libs/cn";
import { ConversationHeader } from "@/components/conversations/conversation-header";

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
    <ConversationHeader
      data-slot="client-header"
      title={name()}
      avatar={client()?.avatar}
      subtitle={t(
        `common.status.${props.info?.onlineStatus ?? "leave"}`,
      )}
      embedded={props.embedded}
      onBack={props.onBack}
      class={cn(
        "sticky top-(--mobile-header-height) z-10 md:top-0",
        props.class,
      )}
      actions={
        <>
          <Show when={!props.embedded}>
            <Tooltip>
              <TooltipTrigger
                as={HeaderLink}
                href={destination()}
                aria-label={destinationLabel()}
              >
                <Show
                  when={isChat()}
                  fallback={
                    <IconChatBubble class="size-5" />
                  }
                >
                  <IconFolderMatch class="size-5" />
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
              <IconSettings class="size-5" />
            </TooltipTrigger>
            <TooltipContent>
              {t("client.config.open")}
            </TooltipContent>
          </Tooltip>
        </>
      }
    />
  );
};
