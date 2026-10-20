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
