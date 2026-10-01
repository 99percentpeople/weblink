import { createHmac } from "node:crypto";
import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  getIceServers,
  parseTurnServer,
  sanitizeTurnServers,
} from "@/libs/domain/ice-server";
import { parseTurnServers } from "@/libs/state/app-options";

const local = {
  url: "turn:example:3478",
  username: "user",
  password: "password",
  authMethod: "longterm",
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("user-configured ICE servers", () => {
  it("encodes HMAC TURN credentials as Base64", async () => {
    const now = 1_790_812_800_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const username = `${Math.floor(now / 1000) + 24 * 3600}:user`;
    const credential = createHmac("sha1", "password")
      .update(username)
      .digest("base64");

    expect(
      await parseTurnServer({
        ...local,
        authMethod: "hmac",
      }),
    ).toEqual({
      urls: local.url,
      username,
      credential,
    });
  });

  it("supports longterm and hmac only", async () => {
    expect(
      parseTurnServers(
        "turn:example|user|password|longterm\nturns:example|user|secret|hmac",
      ),
    ).toHaveLength(2);
    expect(() =>
      parseTurnServers("provider|id|token|cloudflare"),
    ).toThrow("expected longterm or hmac");
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      parseTurnServer({
        ...local,
        authMethod: "cloudflare",
      }),
    ).rejects.toThrow("invalid method");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("discards removed provider credentials from old settings and invite payloads", () => {
    expect(
      sanitizeTurnServers([
        local,
        { ...local, authMethod: "hmac" },
        { ...local, authMethod: "cloudflare" },
        null,
        { url: "turn:example" },
        { ...local, authMethod: "unknown" },
      ]),
    ).toEqual([local, { ...local, authMethod: "hmac" }]);
    expect(sanitizeTurnServers(undefined)).toEqual([]);
    expect(sanitizeTurnServers({})).toEqual([]);
  });

  it("still resolves local TURN without making an HTTP request", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(
      await getIceServers({
        stuns: ["", "stun:example"],
        turns: [local],
      }),
    ).toEqual([
      { urls: "stun:example" },
      {
        urls: "turn:example:3478",
        username: "user",
        credential: "password",
      },
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
