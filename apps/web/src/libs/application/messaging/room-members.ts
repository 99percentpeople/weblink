import type { Client } from "@/libs/domain/client";
import type { Conversation } from "@/libs/domain/conversation";
import type { StoreMessage } from "@/libs/domain/message";

export interface RoomMember extends Client {
  self: boolean;
}

/** Combine current presence with room-scoped evidence and retained private chats. */
export function getRoomMembers(options: {
  room: Extract<Conversation, { kind: "room" }> | undefined;
  activeRoomId: string | null;
  localClient: Client;
  onlineClients: readonly Client[];
  clients: readonly Client[];
  conversations: readonly Conversation[];
  messages: readonly StoreMessage[];
}): { online: RoomMember[]; previous: RoomMember[] } {
  const { room, localClient } = options;
  if (!room) return { online: [], previous: [] };
  const online = new Map<string, RoomMember>();
  if (room.id === options.activeRoomId) {
    online.set(localClient.clientId, {
      ...localClient,
      self: true,
    });
    for (const client of options.onlineClients) {
      if (client.clientId !== localClient.clientId)
        online.set(client.clientId, {
          ...client,
          self: false,
        });
    }
  }
  const seen = new Set<string>();
  // Older versions had no explicit membership record. Only room messages and
  // their original recipient snapshot can establish membership for those chats.
  for (const message of options.messages) {
    if (
      message.conversationId !== room.id ||
      message.room?.roomId !== room.roomId
    )
      continue;
    seen.add(message.client);
    for (const peerId of Object.keys(
      message.deliveries ?? {},
    ))
      seen.add(peerId);
  }
  const clients = new Map(
    options.clients.map((client) => [
      client.clientId,
      client,
    ]),
  );
  const previous = new Map<string, RoomMember>();
  for (const conversation of options.conversations) {
    if (conversation.kind !== "direct") continue;
    const peerId = conversation.peerId;
    if (
      peerId === localClient.clientId ||
      online.has(peerId) ||
      (!conversation.roomConversationIds?.includes(
        room.id,
      ) &&
        !seen.has(peerId))
    )
      continue;
    const client = clients.get(peerId);
    previous.set(peerId, {
      clientId: peerId,
      name: client?.name ?? conversation.title,
      avatar: client?.avatar ?? null,
      self: false,
    });
  }
  const byName = (a: RoomMember, b: RoomMember) =>
    a.name.localeCompare(b.name) ||
    a.clientId.localeCompare(b.clientId);
  return {
    online: [...online.values()].sort(
      (a, b) =>
        Number(b.self) - Number(a.self) || byName(a, b),
    ),
    previous: [...previous.values()].sort(byName),
  };
}
