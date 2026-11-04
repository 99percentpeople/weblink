import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { RoomScreens } from "@/libs/domain/room-screen";
import { ROOM_SCREEN_PREFIX } from "@/libs/domain/native-screen/signaling";
import type {
  RoomConnection,
  RoomScreenTransport,
} from "@weblink/platform";
import type { NativeScreenPublication } from "@/libs/domain/native-screen/sender";
import {
  CONTROL_CHANNEL,
  POINTER_CHANNEL,
  RemotePointer,
} from "@/libs/domain/remote-control/pointer";

const id = "233a7d84-f53c-487d-aab2-15bc267e62c3";
const offer = ROOM_SCREEN_PREFIX + id;
class Stream extends EventTarget {
  constructor(private tracks: MediaStreamTrack[] = []) {
    super();
  }
  addTrack(track: MediaStreamTrack) {
    this.tracks.push(track);
  }
  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter((t) => t !== track);
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
}
const channel = (protocol: string = CONTROL_CHANNEL) =>
  Object.assign(new EventTarget(), {
    label: protocol + "/" + id,
    protocol,
    ordered: protocol === CONTROL_CHANNEL,
    maxPacketLifeTime: null,
    maxRetransmits: protocol === CONTROL_CHANNEL ? null : 0,
    readyState: "open",
    close: vi.fn(),
  });
beforeEach(() => vi.stubGlobal("MediaStream", Stream));
afterEach(() => vi.unstubAllGlobals());

it("preserves the early ready handshake until the authorized screen offer binds both channels", () => {
  const screens = new RoomScreens(
    () => ({}) as RoomConnection,
    () => true,
    false,
  );
  const reliable = channel(),
    movement = channel(POINTER_CHANNEL);
  screens.channel(reliable as unknown as RTCDataChannel);
  reliable.dispatchEvent(
    new MessageEvent("message", {
      data: JSON.stringify({
        type: "ready",
        generation: id,
        target: {
          sourceId: "source",
          mediaId: id,
          geometryRevision: "geometry",
        },
      }),
    }),
  );
  screens.channel(movement as unknown as RTCDataChannel);
  const pointer = new RemotePointer("source", id);
  const states: string[] = [];
  pointer.addEventListener("change", () =>
    states.push(pointer.state()),
  );
  const receiver = screens.receiver(
    offer,
    {},
    vi.fn(),
    vi.fn(),
    undefined,
    pointer,
  );
  try {
    expect(pointer.state()).toBe("viewing");
    expect(states.at(-1)).toBe("viewing");
  } finally {
    receiver.close();
  }
});

it("matches early RTP and input channels to an authorized publication, then releases only its resources", async () => {
  let allowed = true;
  const screens = new RoomScreens(
    () => ({}) as RoomConnection,
    () => allowed,
    true,
  );
  const video = Object.assign(new EventTarget(), {
    kind: "video",
  });
  const event = {
    track: video,
    streams: [],
    roomStreamIds: ["weblink-screen-" + id],
  } as unknown as RTCTrackEvent;
  const input = channel(),
    changed = vi.fn();
  const control = Object.assign(new EventTarget(), {
    bind: vi.fn(),
    close: vi.fn(),
  });
  expect(screens.track(event)).toBe(true);
  expect(
    screens.channel(input as unknown as RTCDataChannel),
  ).toBe(true);
  const receiver = screens.receiver(
    offer,
    {},
    changed,
    vi.fn(),
    undefined,
    control as unknown as RemotePointer,
  );
  expect(await receiver.answer(offer)).toBe(offer);
  await receiver.connected();
  expect(receiver.stream.getVideoTracks()).toEqual([video]);
  expect(control.bind).toHaveBeenCalledWith(input, id);
  expect(() =>
    screens.receiver(offer, {}, changed, vi.fn()),
  ).toThrow();
  receiver.close();
  expect(control.close).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenLastCalledWith(null);
  allowed = false;
  const denied = channel();
  screens.channel(denied as unknown as RTCDataChannel);
  expect(denied.close).toHaveBeenCalledOnce();
  expect(() =>
    screens.receiver(offer, {}, changed, vi.fn()),
  ).toThrow();
  expect(
    screens.track({
      ...event,
      roomStreamIds: ["ordinary-camera"],
    } as RTCTrackEvent),
  ).toBe(false);
});

it("publishes and retires a screen on its original room even after a reconnect", async () => {
  const room: RoomScreenTransport = {
    attachScreen: vi.fn(async () => false),
    detachScreen: vi.fn(async () => {}),
    screenReady: vi.fn(async () => {}),
    receiveContent: vi.fn(),
  };
  let active: RoomScreenTransport | null = room;
  const screens = new RoomScreens(
    () => null,
    () => true,
    true,
  );
  const pub: NativeScreenPublication = {
    sourceId: "display",
    captureId: "capture",
    offer: vi.fn(),
    answer: vi.fn(),
    closePeer: vi.fn(),
  };
  const shared = screens.publication(pub, () => active);
  const codecs = {
    video: "video/h265",
    audio: "audio/opus",
  };
  expect(
    await shared.offer(
      id,
      [],
      false,
      undefined,
      undefined,
      codecs,
    ),
  ).toBe(offer);
  expect(room.attachScreen).toHaveBeenCalledWith(
    "capture",
    id,
    codecs,
    undefined,
  );
  expect(
    await shared.offer(
      "second",
      [],
      false,
      undefined,
      {
        ownerId: "owner",
        peerGeneration: "peer",
        clientId: "viewer",
        sourceId: "display",
      },
      codecs,
    ),
  ).toEqual({
    sdp: ROOM_SCREEN_PREFIX + "second",
    control: false,
  });
  await shared.closePeer("second");
  await expect(
    shared.answer(id, offer + "other"),
  ).rejects.toThrow();
  await shared.answer(id, offer);
  expect(room.screenReady).toHaveBeenCalledWith(id);
  active = null;
  await shared.closePeer(id);
  expect(room.detachScreen).toHaveBeenCalledWith(id);
  expect(pub.offer).not.toHaveBeenCalled();
  expect(pub.closePeer).not.toHaveBeenCalled();
});
