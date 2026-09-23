import type { StoreMessage } from "@/libs/domain/message";

export function snapshotStoreMessage(
  message: StoreMessage,
): StoreMessage {
  const room = message.room
    ? { ...message.room }
    : undefined;
  const deliveries = message.deliveries
    ? { ...message.deliveries }
    : undefined;
  if (message.type === "text") {
    return {
      ...message,
      room,
      deliveries,
    };
  }
  return {
    ...message,
    room,
    deliveries,
    roomTransfers: message.roomTransfers
      ? Object.fromEntries(
          Object.entries(message.roomTransfers).map(
            ([peer, transfer]) => [
              peer,
              {
                ...transfer,
                progress: transfer.progress
                  ? { ...transfer.progress }
                  : undefined,
              },
            ],
          ),
        )
      : undefined,
    progress: message.progress
      ? { ...message.progress }
      : undefined,
  };
}
