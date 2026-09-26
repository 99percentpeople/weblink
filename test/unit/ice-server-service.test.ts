import {
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
const { getManaged } = vi.hoisted(() => ({
  getManaged: vi.fn<() => Promise<RTCIceServer[]>>(),
}));
vi.mock("@/libs/state/app-options", () => ({
  signalingWebSocketUrl: "wss://signal.example/ws",
}));
vi.mock(
  "@/libs/infrastructure/ice/turn-credentials-client",
  async (original) => {
    const actual =
      await original<
        typeof import("@/libs/infrastructure/ice/turn-credentials-client")
      >();
    return {
      ...actual,
      TurnCredentialsClient: class {
        getIceServers = getManaged;
      },
    };
  },
);
import {
  loadSessionIceServers,
  getServerIceServers,
} from "@/libs/application/ice-server-service";
const custom = {
  stuns: ["stun:local.example"],
  turns: [
    {
      url: "turn:local.example",
      username: "u",
      password: "p",
      authMethod: "longterm",
    },
  ],
};
const managed = [
  {
    urls: ["turn:managed.example"],
    username: "temporary",
    credential: "temporary",
  },
];
beforeEach(() => {
  getManaged.mockReset().mockResolvedValue(managed);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("ICE server composition", () => {
  it("does not request credentials just by constructing the application service", () => {
    expect(getManaged).not.toHaveBeenCalled();
  });
  it("combines local STUN/TURN settings with backend credentials", async () => {
    expect(await loadSessionIceServers(custom)).toEqual([
      { urls: "stun:local.example" },
      {
        urls: "turn:local.example",
        username: "u",
        credential: "p",
      },
      ...managed,
    ]);
  });
  it("preserves configured ICE when the backend is unavailable", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    getManaged.mockRejectedValue(
      new Error("TURN credentials request failed: 503"),
    );
    expect(await loadSessionIceServers(custom)).toEqual([
      { urls: "stun:local.example" },
      {
        urls: "turn:local.example",
        username: "u",
        credential: "p",
      },
    ]);
    await expect(getServerIceServers()).rejects.toThrow(
      "503",
    );
  });
});
