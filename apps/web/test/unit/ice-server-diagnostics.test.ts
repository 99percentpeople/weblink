import { describe, expect, it, vi } from "vitest";
import {
  IceServerDiagnostics,
  type IceServerDiagnosticsOptions,
} from "@/libs/application/ice-server-diagnostics";
import type { TurnServerOptions } from "@/libs/domain/ice-server";

function createHarness() {
  const parseTurnServer =
    vi.fn<IceServerDiagnosticsOptions["parseTurnServer"]>();
  const checkAvailability =
    vi.fn<
      IceServerDiagnosticsOptions["checkAvailability"]
    >();
  const service = new IceServerDiagnostics({
    parseTurnServer,
    checkAvailability,
  });
  return { service, parseTurnServer, checkAvailability };
}

function turn(url: string): TurnServerOptions {
  return {
    url,
    username: "user",
    password: "secret",
    authMethod: "longterm",
  };
}

describe("ICE server diagnostics", () => {
  it("checks STUN with srflx candidates and retains each success, failure and unavailable result", async () => {
    const { service, parseTurnServer, checkAvailability } =
      createHarness();
    checkAvailability
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("timeout"));
    expect(
      await service.checkStunServers([
        "stun:a",
        "stun:b",
        "stun:c",
      ]),
    ).toEqual([
      { server: "stun:a", msg: "available" },
      { server: "stun:b", msg: "unavailable" },
      { server: "stun:c", msg: "timeout" },
    ]);
    expect(checkAvailability).toHaveBeenNthCalledWith(
      1,
      { urls: ["stun:a"] },
      {
        iceTransportPolicy: "all",
        candidateType: "srflx",
      },
    );
    expect(parseTurnServer).not.toHaveBeenCalled();
  });

  it("keeps probes concurrent and reports them in completion order", async () => {
    const { service, checkAvailability } = createHarness();
    let finishSlow!: (available: boolean) => void;
    checkAvailability
      .mockReturnValueOnce(
        new Promise<boolean>((resolve) => {
          finishSlow = resolve;
        }),
      )
      .mockResolvedValueOnce(true);
    const pending = service.checkStunServers([
      "stun:slow",
      "stun:fast",
    ]);
    expect(checkAvailability).toHaveBeenCalledTimes(2);
    await Promise.resolve();
    await Promise.resolve();
    finishSlow(false);
    expect(await pending).toEqual([
      { server: "stun:fast", msg: "available" },
      { server: "stun:slow", msg: "unavailable" },
    ]);
  });

  it("resolves TURN credentials and checks relay availability without changing configuration", async () => {
    const { service, parseTurnServer, checkAvailability } =
      createHarness();
    const configured = turn("turn:example");
    const resolved = {
      urls: "turn:resolved",
      username: "ephemeral",
      credential: "token",
    };
    parseTurnServer.mockResolvedValue(resolved);
    checkAvailability.mockResolvedValue(true);

    expect(
      await service.checkTurnServers([configured]),
    ).toEqual([
      { server: "turn:example", msg: "available" },
    ]);
    expect(parseTurnServer).toHaveBeenCalledWith(
      configured,
    );
    expect(checkAvailability).toHaveBeenCalledWith(
      resolved,
      { iceTransportPolicy: "relay" },
    );
    expect(configured).toEqual(turn("turn:example"));
  });

  it("continues past credential and probe failures without dropping other TURN results", async () => {
    const { service, parseTurnServer, checkAvailability } =
      createHarness();
    parseTurnServer
      .mockRejectedValueOnce(
        new Error("credentials rejected"),
      )
      .mockResolvedValueOnce({ urls: "turn:b" })
      .mockResolvedValueOnce({ urls: "turn:c" });
    checkAvailability
      .mockRejectedValueOnce(new Error("relay timeout"))
      .mockResolvedValueOnce(true);

    expect(
      await service.checkTurnServers([
        turn("turn:a"),
        turn("turn:b"),
        turn("turn:c"),
      ]),
    ).toEqual([
      { server: "turn:a", msg: "credentials rejected" },
      { server: "turn:b", msg: "relay timeout" },
      { server: "turn:c", msg: "available" },
    ]);
    expect(checkAvailability).toHaveBeenCalledTimes(2);
  });

  it("contains synchronous and non-Error failures from adapters", async () => {
    const { service, parseTurnServer, checkAvailability } =
      createHarness();
    checkAvailability.mockImplementation(() => {
      throw "probe failed";
    });
    parseTurnServer.mockImplementation(() => {
      throw "credentials failed";
    });
    expect(
      await service.checkStunServers(["stun:a"]),
    ).toEqual([{ server: "stun:a", msg: "probe failed" }]);
    expect(
      await service.checkTurnServers([turn("turn:a")]),
    ).toEqual([
      { server: "turn:a", msg: "credentials failed" },
    ]);
  });

  it("does no network work for empty lists", async () => {
    const { service, parseTurnServer, checkAvailability } =
      createHarness();
    expect(await service.checkStunServers([])).toEqual([]);
    expect(await service.checkTurnServers([])).toEqual([]);
    expect(parseTurnServer).not.toHaveBeenCalled();
    expect(checkAvailability).not.toHaveBeenCalled();
  });
});
