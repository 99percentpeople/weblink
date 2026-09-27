import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createClientService,
  waitForRoomAvailability,
} from "@/libs/application/client-service-factory";

const mocks = vi.hoisted(() => {
  const service = { close: vi.fn() };
  return {
    service,
    create: vi.fn(() => service),
    lockName: vi.fn(() => "room-lock"),
    wait: vi.fn(
      async (_name: string, _signal: AbortSignal) => true,
    ),
  };
});

vi.mock("@/libs/state/app-options", () => ({
  signalingWebSocketUrl: "wss://signaling.test/room",
}));
vi.mock(
  "@/libs/infrastructure/signaling/client/ws-client-service",
  () => ({
    WebSocketClientService: mocks.create,
  }),
);
vi.mock(
  "@/libs/infrastructure/signaling/client/room-connection-lock",
  () => ({
    roomConnectionLockName: mocks.lockName,
    waitForRoomConnectionAvailability: mocks.wait,
  }),
);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.wait.mockResolvedValue(true);
});
afterEach(() => vi.restoreAllMocks());

describe("WebSocket client composition", () => {
  it("creates the client using the deployment URL without a backend selector", async () => {
    const options = {
      roomId: "room-a",
      password: null,
      client: {
        clientId: "local",
        name: "Local",
        avatar: null,
      },
      onNotice: vi.fn(),
      websocketUrl: "wss://not-the-deployment.test",
    };
    expect(await createClientService(options)).toBe(
      mocks.service,
    );
    expect(mocks.create).toHaveBeenCalledWith({
      ...options,
      websocketUrl: "wss://signaling.test/room",
    });
  });

  it.each([true, false])(
    "returns room availability %s using the same deployment identity",
    async (available) => {
      mocks.wait.mockResolvedValueOnce(available);
      const controller = new AbortController();
      expect(
        await waitForRoomAvailability(
          "room-a",
          "local",
          controller.signal,
        ),
      ).toBe(available);
      expect(mocks.lockName).toHaveBeenCalledWith(
        "wss://signaling.test/room",
        "room-a",
        "local",
      );
      expect(mocks.wait).toHaveBeenCalledWith(
        "room-lock",
        controller.signal,
      );
    },
  );

  it("propagates cancellation from the availability wait", async () => {
    const controller = new AbortController();
    controller.abort();
    const error = new DOMException(
      "Room wait aborted",
      "AbortError",
    );
    mocks.wait.mockRejectedValueOnce(error);
    await expect(
      waitForRoomAvailability(
        "room-a",
        "local",
        controller.signal,
      ),
    ).rejects.toBe(error);
  });
});
