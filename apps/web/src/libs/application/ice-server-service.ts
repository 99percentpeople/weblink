import {
  getIceServers,
  type IceServerOptions,
} from "@/libs/domain/ice-server";
import {
  getTurnCredentialsUrl,
  TurnCredentialsClient,
} from "@/libs/infrastructure/ice/turn-credentials-client";
import { signalingWebSocketUrl } from "@/libs/state/app-options";
export { getTurnCredentialsUrl as serverTurnCredentialsUrl } from "@/libs/infrastructure/ice/turn-credentials-client";

let cached:
  | { endpoint: string; client: TurnCredentialsClient }
  | undefined;

export function getServerIceServers(
  websocketUrl = signalingWebSocketUrl,
): Promise<RTCIceServer[]> {
  const endpoint = getTurnCredentialsUrl(websocketUrl);
  if (!endpoint) return Promise.resolve([]);
  if (cached?.endpoint !== endpoint)
    cached = {
      endpoint,
      client: new TurnCredentialsClient(endpoint),
    };
  return cached.client.getIceServers();
}

/** Compose user ICE endpoints with the signaling backend's temporary TURN credentials. */
export async function loadSessionIceServers(
  options: IceServerOptions,
  websocketUrl = signalingWebSocketUrl,
): Promise<RTCIceServer[]> {
  const [custom, managed] = await Promise.all([
    getIceServers(options),
    getServerIceServers(websocketUrl).catch(
      (error: unknown) => {
        console.warn(
          "[IceServers] server TURN unavailable; using configured ICE servers",
          error,
        );
        return [] as RTCIceServer[];
      },
    ),
  ]);
  return [...custom, ...managed];
}
