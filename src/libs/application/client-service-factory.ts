import type {
  ClientService,
  ClientServiceInitOptions,
} from "@/libs/domain/client";
import { signalingWebSocketUrl } from "@/libs/state/app-options";

export async function createClientService(
  options: ClientServiceInitOptions,
): Promise<ClientService> {
  switch (import.meta.env.VITE_BACKEND) {
    case "FIREBASE":
      return import("@/libs/infrastructure/signaling/client/firebase-client-service").then(
        (module) =>
          new module.FirebaseClientService(options),
      );
    case "WEBSOCKET":
      return import("@/libs/infrastructure/signaling/client/ws-client-service").then(
        (module) =>
          new module.WebSocketClientService({
            ...options,
            websocketUrl: signalingWebSocketUrl,
          }),
      );
    default:
      throw new Error("invalid backend type");
  }
}
