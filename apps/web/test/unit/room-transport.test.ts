import {
  afterEach,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import {
  browserRoomTransport,
  type RoomConnection,
  type RoomConfiguration,
  type RoomChannelOptions,
  type RoomDescription,
} from "@weblink/platform";
import { platform } from "@/libs/platform/runtime";

afterEach(() => vi.unstubAllGlobals());

it("creates browser peers through the room factory using the shared signaling contract", async () => {
  class BrowserPeer {
    constructor(readonly config: RTCConfiguration) {}
  }
  vi.stubGlobal("RTCPeerConnection", BrowserPeer);
  const transport = await platform.getRoomTransport?.();
  expect(transport).toBe(browserRoomTransport);
  const config: RoomConfiguration = {
    iceServers: [],
    iceTransportPolicy: "relay",
  };
  const pc = transport?.create(config, "remote");
  expect(pc).toBeInstanceOf(BrowserPeer);
  expect(pc).toMatchObject({ config });
  expectTypeOf<
    RoomConnection["setLocalDescription"]
  >().parameters.toEqualTypeOf<[]>();
  expectTypeOf<
    RoomConnection["getStats"]
  >().parameters.toEqualTypeOf<[]>();
  expectTypeOf<RoomDescription["type"]>().toEqualTypeOf<
    "offer" | "answer"
  >();
  expectTypeOf<{
    negotiated: true;
    id: number;
  }>().not.toMatchTypeOf<RoomChannelOptions>();
});
