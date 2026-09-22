import {
  parseTurnServer,
  type TurnServerOptions,
} from "@/libs/domain/ice-server";
import { checkIceServerAvailability } from "@/libs/domain/utils/turn";

export interface IceServerDiagnosticResult {
  server: string;
  msg: string;
}

export interface IceServerDiagnosticsOptions {
  parseTurnServer: typeof parseTurnServer;
  checkAvailability: typeof checkIceServerAvailability;
}

function failure(
  server: string,
  error: unknown,
): IceServerDiagnosticResult {
  return {
    server,
    msg:
      error instanceof Error
        ? error.message
        : String(error),
  };
}

/** Settings diagnostics own no UI state and never alter the configured servers. */
export class IceServerDiagnostics {
  constructor(
    private readonly options: IceServerDiagnosticsOptions = {
      parseTurnServer,
      checkAvailability: checkIceServerAvailability,
    },
  ) {}

  private async check(
    name: string,
    server: RTCIceServer,
    options: Parameters<
      typeof checkIceServerAvailability
    >[1],
  ): Promise<IceServerDiagnosticResult> {
    try {
      const available =
        await this.options.checkAvailability(
          server,
          options,
        );
      return {
        server: name,
        msg: available ? "available" : "unavailable",
      };
    } catch (error) {
      return failure(name, error);
    }
  }

  async checkStunServers(
    servers: readonly string[],
  ): Promise<IceServerDiagnosticResult[]> {
    const results: IceServerDiagnosticResult[] = [];
    await Promise.all(
      servers.map((server) =>
        this.check(
          server,
          { urls: [server] },
          {
            iceTransportPolicy: "all",
            candidateType: "srflx",
          },
        ).then((result) => {
          results.push(result);
        }),
      ),
    );
    return results;
  }

  async checkTurnServers(
    servers: readonly TurnServerOptions[],
  ): Promise<IceServerDiagnosticResult[]> {
    const results: IceServerDiagnosticResult[] = [];
    const checks: Promise<void>[] = [];
    // Keep credential resolution sequential and availability probes concurrent,
    // matching the original settings workflow and its completion-order report.
    for (const turn of servers) {
      let server: RTCIceServer;
      try {
        server = await this.options.parseTurnServer(turn);
      } catch (error) {
        results.push(failure(turn.url, error));
        continue;
      }
      checks.push(
        this.check(turn.url, server, {
          iceTransportPolicy: "relay",
        }).then((result) => {
          results.push(result);
        }),
      );
    }
    await Promise.all(checks);
    return results;
  }
}
