export type ConversationID = string;

interface BaseConversation {
  id: ConversationID;
  title: string;
  labelIds: string[];
  createdAt: number;
  lastReadMessageId?: string;
  lastReadAt?: number;
  lastReadSequence?: number;
}

export type Conversation = BaseConversation &
  (
    | {
        kind: "direct";
        peerId: string;
        /** Rooms observed locally, retained only with this private conversation. */
        roomConversationIds?: ConversationID[];
      }
    | { kind: "room"; roomId: string; namespace: string }
  );

export interface ConversationLabel {
  id: string;
  name: string;
  color?: string;
}

/** Both endpoints derive the same identity, including after a profile change. */
export function directConversationId(
  localId: string,
  peerId: string,
): ConversationID {
  return `direct:${JSON.stringify([localId, peerId].sort())}`;
}

/** A room name on two different signaling services is not the same room. */
export function roomConversationId(
  namespace: string,
  roomId: string,
): ConversationID {
  return `room:${JSON.stringify([namespace, roomId])}`;
}
