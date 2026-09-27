import type {
  MessageDeliveryStatus,
  StoreMessage,
} from "@/libs/domain/message";

/** Compatibility projection for consumers of the historical top-level status. */
export function deliveryStatus(
  deliveries: Record<string, MessageDeliveryStatus>,
): StoreMessage["status"] {
  const states = Object.values(deliveries);
  if (states.includes("sending")) return "sending";
  if (
    states.some(
      (state) =>
        state === "failed" || state === "unsupported",
    )
  )
    return "error";
  return "received";
}

export function recoverMessageDelivery(
  message: StoreMessage,
): StoreMessage {
  if (message.deliveries) {
    const deliveries = Object.fromEntries(
      Object.entries(message.deliveries).map(
        ([peer, status]) => [
          peer,
          status === "sending" ? "failed" : status,
        ],
      ),
    ) as Record<string, MessageDeliveryStatus>;
    return {
      ...message,
      deliveries,
      status: deliveryStatus(deliveries),
    };
  }
  if (message.status === "sending")
    return { ...message, status: "error" };
  return message;
}
