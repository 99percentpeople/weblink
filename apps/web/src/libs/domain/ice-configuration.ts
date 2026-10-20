/** Compare requested ICE settings without browser-added configuration fields. */
export function sameIceServers(
  left: readonly RTCIceServer[],
  right: readonly RTCIceServer[],
): boolean {
  const normalize = (servers: readonly RTCIceServer[]) =>
    servers.map(({ urls, username, credential }) => [
      typeof urls === "string" ? [urls] : urls,
      username ?? "",
      credential ?? "",
    ]);
  return (
    JSON.stringify(normalize(left)) ===
    JSON.stringify(normalize(right))
  );
}

export class PeerConnectionConfigurationError extends Error {
  readonly code = "peer-connection-config";

  constructor(cause: unknown) {
    super(
      "Failed to update peer connection configuration",
      {
        cause,
      },
    );
    this.name = "PeerConnectionConfigurationError";
  }
}
