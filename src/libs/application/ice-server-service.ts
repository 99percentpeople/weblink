import {
  getIceServers,
  type IceServerOptions,
} from "@/libs/domain/ice-server";
import {
  getTurnCredentialsUrl,
  TurnCredentialsClient,
} from "@/libs/infrastructure/ice/turn-credentials-client";
import { signalingWebSocketUrl } from "@/libs/state/app-options";

export const serverTurnCredentialsUrl =
  getTurnCredentialsUrl(signalingWebSocketUrl);
const credentialsClient = serverTurnCredentialsUrl
  ? new TurnCredentialsClient(serverTurnCredentialsUrl)
  : undefined;

export function getServerIceServers(): Promise<
  RTCIceServer[]
> {
  return (
    credentialsClient?.getIceServers() ??
    Promise.resolve([])
  );
}

/** Compose user ICE endpoints with the signaling backend's temporary TURN credentials. */
export async function loadSessionIceServers(
  options: IceServerOptions,
): Promise<RTCIceServer[]> {
  const [custom, managed] = await Promise.all([
    getIceServers(options),
    getServerIceServers().catch((error: unknown) => {
      console.warn(
        "[IceServers] server TURN unavailable; using configured ICE servers",
        error,
      );
      return [] as RTCIceServer[];
    }),
  ]);
  return [...custom, ...managed];
}
