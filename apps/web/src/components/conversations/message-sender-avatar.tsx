import { createMemo } from "solid-js";
import { ClientAvatar } from "@/components/common/client-avatar";
import { cn } from "@/libs/cn";
import type { Client } from "@/libs/domain/client";
import type { StoreMessage } from "@/libs/domain/message";
import { appState } from "@/libs/state/app-state";

export function MessageSenderAvatar(props: {
  message: StoreMessage;
  peer?: Pick<Client, "clientId" | "name" | "avatar">;
  class?: string;
}) {
  const sender = createMemo(() => {
    const message = props.message;
    const outgoing =
      message.client === appState.profile.clientId;
    const client =
      appState.session.clientViewData[message.client] ??
      (props.peer?.clientId === message.client
        ? props.peer
        : undefined) ??
      appState.message.clients.find(
        (client) => client.clientId === message.client,
      );
    return {
      name:
        message.room?.senderName ??
        (outgoing
          ? appState.profile.name
          : (client?.name ?? message.client)),
      avatar:
        message.room?.senderAvatar ??
        (outgoing
          ? appState.profile.avatar
          : client?.avatar) ??
        undefined,
    };
  });
  return (
    <ClientAvatar
      data-slot="message-sender-avatar"
      name={sender().name}
      avatar={sender().avatar}
      class={cn(
        "size-7 shrink-0 self-start text-[10px]",
        props.class,
      )}
      title={sender().name}
      aria-label={sender().name}
      role="img"
    />
  );
}
