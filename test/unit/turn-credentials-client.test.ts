import { describe, expect, it, vi } from "vitest";
import {
  getTurnCredentialsUrl,
  TurnCredentialsClient,
} from "@/libs/infrastructure/ice/turn-credentials-client";

const endpoint = "https://ws.example/turn-credentials";
const servers = [
  { urls: ["stun:stun.example:3478"] },
  {
    urls: ["turn:relay.example:3478"],
    username: "temporary-user",
    credential: "temporary-password",
  },
];
function setup() {
  let now = 1_800_000_000_000;
  const fetcher = vi.fn<typeof fetch>();
  const client = new TurnCredentialsClient(endpoint, {
    fetch: fetcher,
    now: () => now,
  });
  const response = (expiresAt = now + 3_600_000) =>
    Response.json({ iceServers: servers, expiresAt });
  fetcher.mockImplementation(async () => response());
  return {
    client,
    fetcher,
    response,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("TURN credentials client", () => {
  it("derives the backend root HTTP endpoint without forwarding query credentials", () => {
    expect(
      getTurnCredentialsUrl(
        "wss://user:password@ws.example/ws?room=r&pwd=p#x",
      ),
    ).toBe(endpoint);
    expect(
      getTurnCredentialsUrl(
        "ws://127.0.0.1:9000/signaling",
      ),
    ).toBe("http://127.0.0.1:9000/turn-credentials");
    expect(
      getTurnCredentialsUrl(undefined),
    ).toBeUndefined();
    expect(
      getTurnCredentialsUrl("not-a-url"),
    ).toBeUndefined();
    expect(
      getTurnCredentialsUrl("https://example"),
    ).toBeUndefined();
  });

  it("does not request credentials until used, and caches only in memory", async () => {
    const { client, fetcher } = setup();
    expect(fetcher).not.toHaveBeenCalled();
    const result = await client.getIceServers();
    expect(result).toEqual(servers);
    expect(fetcher).toHaveBeenCalledWith(
      endpoint,
      expect.objectContaining({
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        signal: expect.any(AbortSignal),
      }),
    );
    result[1].credential = "mutated";
    expect(await client.getIceServers()).toEqual(servers);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("coalesces simultaneous requests from multiple peers", async () => {
    const { client, fetcher, response } = setup();
    let resolve!: (value: Response) => void;
    fetcher.mockReturnValueOnce(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    const a = client.getIceServers();
    const b = client.getIceServers();
    expect(fetcher).toHaveBeenCalledTimes(1);
    resolve(response());
    expect(await a).toEqual(servers);
    expect(await b).toEqual(servers);
    expect(await a).not.toBe(await b);
  });

  it("refreshes on demand five minutes before expiry, without a polling timer", async () => {
    const { client, fetcher, advance } = setup();
    await client.getIceServers();
    advance(55 * 60_000 - 1);
    await client.getIceServers();
    expect(fetcher).toHaveBeenCalledTimes(1);
    advance(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.getIceServers();
    expect(fetcher).toHaveBeenCalledTimes(2);
    advance(24 * 3_600_000);
    await client.getIceServers();
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("can use an unexpired cache during failed early refresh but never expired credentials", async () => {
    const { client, fetcher, advance } = setup();
    await client.getIceServers();
    advance(56 * 60_000);
    fetcher.mockRejectedValue(new Error("offline"));
    expect(await client.getIceServers()).toEqual(servers);
    advance(5 * 60_000);
    await expect(client.getIceServers()).rejects.toThrow(
      "offline",
    );
  });

  it("does not cache failed requests permanently", async () => {
    const { client, fetcher } = setup();
    fetcher.mockResolvedValueOnce(
      new Response(null, { status: 503 }),
    );
    await expect(client.getIceServers()).rejects.toThrow(
      "503",
    );
    expect(await client.getIceServers()).toEqual(servers);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed or expired responses", async () => {
    const invalid = [
      null,
      {},
      { iceServers: servers, expiresAt: 0 },
      { iceServers: [], expiresAt: 2_000_000_000_000 },
      { iceServers: servers, expiresAt: "2000000000000" },
      { iceServers: [null], expiresAt: 2_000_000_000_000 },
      {
        iceServers: [{ urls: ["turn:example"] }],
        expiresAt: 2_000_000_000_000,
      },
      {
        iceServers: [{ urls: ["https://example"] }],
        expiresAt: 2_000_000_000_000,
      },
      {
        iceServers: [servers[0]],
        expiresAt: 2_000_000_000_000,
      },
    ];
    for (const payload of invalid) {
      const { client, fetcher } = setup();
      fetcher.mockResolvedValueOnce(Response.json(payload));
      await expect(
        client.getIceServers(),
      ).rejects.toThrow();
    }
  });

  it("uses a bounded request timeout", async () => {
    const signal = AbortSignal.abort(
      new DOMException("timeout", "TimeoutError"),
    );
    const timeout = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(signal);
    try {
      const { client, fetcher } = setup();
      fetcher.mockImplementation(async (_url, init) => {
        init?.signal?.throwIfAborted();
        throw new Error("unexpected");
      });
      await expect(client.getIceServers()).rejects.toThrow(
        "timeout",
      );
      expect(timeout).toHaveBeenCalledWith(12_000);
    } finally {
      timeout.mockRestore();
    }
  });
});
