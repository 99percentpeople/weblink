import type { Conversation } from "@/libs/domain/conversation";
import type { StoreMessage } from "@/libs/domain/message";
import type { NotificationAvatar } from "./notification-avatar";

interface Sender {
  name: string;
  avatar: string | null;
}

export function messageNotificationContent(
  message: StoreMessage,
  conversation: Conversation,
  sender: Sender | undefined,
  preview: boolean,
  newMessage: string,
): {
  title: string;
  body: string;
  avatar?: NotificationAvatar;
} {
  if (!preview)
    return { title: newMessage, body: newMessage };
  const profile =
    sender ??
    (message.room && {
      name: message.room.senderName,
      avatar: message.room.senderAvatar,
    });
  const name = profile?.name || message.client;
  return {
    title:
      conversation.kind === "room"
        ? `${name.slice(0, 80)} · ${conversation.title.slice(0, 80)}`
        : name.slice(0, 160),
    body: (message.type === "text"
      ? message.data
      : message.fileName
    ).slice(0, 1000),
    avatar: { name, avatar: profile?.avatar },
  };
}
