import {
  splitProps,
  type Component,
  type ComponentProps,
} from "solid-js";
import type { Client } from "@/libs/domain/client";
import { directConversationId } from "@/libs/domain/conversation";
import { appState } from "@/libs/state/app-state";
import { ConversationComposer } from "@/components/conversations/conversation-composer";

export const ChatBar: Component<
  Omit<ComponentProps<"div">, "onPaste"> & {
    client: Client;
    onSent?: () => void;
  }
> = (props) => {
  const [local, other] = splitProps(props, [
    "client",
    "class",
    "onSent",
  ]);
  const peer = () =>
    appState.session.clientViewData[local.client.clientId];
  return (
    <ConversationComposer
      {...other}
      class={local.class}
      conversationId={directConversationId(
        appState.profile.clientId,
        local.client.clientId,
      )}
      title={local.client.name}
      disabled={
        peer()?.onlineStatus !== "online" ||
        !peer()?.messageChannel
      }
      onSent={local.onSent}
    />
  );
};
