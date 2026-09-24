import type {
  ClientService,
  ClientServiceInitOptions,
} from "@/libs/domain/client";
import { signalingWebSocketUrl } from "@/libs/state/app-options";

export async function createClientService(
  options: ClientServiceInitOptions,
): Promise<ClientService> {
  const { WebSocketClientService } =
    await import("@/libs/infrastructure/signaling/client/ws-client-service");
  return new WebSocketClientService({
    ...options,
    websocketUrl: signalingWebSocketUrl,
  });
}

export async function waitForRoomAvailability(
  roomId: string,
  clientId: string,
  signal: AbortSignal,
): Promise<boolean> {
  const {
    roomConnectionLockName,
    waitForRoomConnectionAvailability,
  } =
    await import("@/libs/infrastructure/signaling/client/room-connection-lock");
  return waitForRoomConnectionAvailability(
    roomConnectionLockName(
      signalingWebSocketUrl,
      roomId,
      clientId,
    ),
    signal,
  );
}
