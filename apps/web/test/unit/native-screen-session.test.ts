import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  NativeScreenSession,
  parseScreenSignal,
  type NativeScreenPublication,
} from "@/libs/domain/native-screen/session";
import { getNativeScreenAudioOwner } from "@/libs/domain/native-screen/tracks";
import { ScreenDecodeError } from "@/libs/domain/native-screen/errors";

class Stream {
  constructor(private tracks: MediaStreamTrack[] = []) {}
  getTracks() {
    return this.tracks;
  }
  getVideoTracks() {
    return this.tracks.filter((t) => t.kind === "video");
  }
  getAudioTracks() {
    return this.tracks.filter((t) => t.kind === "audio");
  }
}
const mediaStream = (id: string) =>
  new Stream([
    { id, kind: "video" } as MediaStreamTrack,
    {
      id: `${id}-audio`,
      kind: "audio",
    } as MediaStreamTrack,
  ]) as unknown as MediaStream;

const receivers = vi.hoisted(() => [] as any[]);
vi.mock("@/libs/domain/native-screen/receiver", () => ({
  ScreenReceiver: class {
    constructor(
      readonly config: RTCConfiguration,
      readonly changed: (stream: any) => void,
      readonly failed: (error: unknown) => void,
      readonly candidate?: (
        candidate: RTCIceCandidateInit,
      ) => void,
    ) {
      receivers.push(this);
    }
    answer = vi.fn(async () => "browser-answer");
    connected = vi.fn(async () => {});
    monitorDecode = vi.fn();
    decodeFailed = vi.fn();
    addIceCandidate = vi.fn(async () => {});
    close = vi.fn(() => this.changed(null));
  },
}));
class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  sent: any[] = [];
  send = vi.fn((data: string) =>
    this.sent.push(JSON.parse(data)),
  );
  close = vi.fn(() => {
    this.readyState = "closed";
  });
  receive(value: unknown) {
    const event = new Event("message");
    Object.defineProperty(event, "data", {
      value: JSON.stringify(value),
    });
    this.dispatchEvent(event);
  }
}
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const publication = (
  sourceId = "selected-source",
): NativeScreenPublication => ({
  sourceId,
  offer: vi.fn(async () => "native-offer"),
  answer: vi.fn(async () => {}),
  closePeer: vi.fn(async () => {}),
});
function setup() {
  const port = {
    loadIceServers: vi.fn(async () => [
      {
        urls: "turn:relay",
        username: "user",
        credential: "temporary",
      },
    ]),
    relayOnly: () => true,
    changed: vi.fn(),
    error: vi.fn(),
    viewsChanged: vi.fn(),
  };
  const session = new NativeScreenSession(port);
  const channel = new Channel();
  session.bind(channel as unknown as RTCDataChannel);
  return { session, channel, port };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("MediaStream", Stream);
  receivers.length = 0;
});

it("retains a failed codec card without retry until the publisher explicitly stops", async () => {
  const { session, channel, port } = setup();
  channel.receive({
    type: "hello",
    receiveScreen: true,
    multiScreen: true,
  });
  channel.receive({
    type: "offer",
    id: "hevc",
    sourceId: "screen",
    sdp: "offer",
  });
  await flush();
  receivers[0].changed(mediaStream("video"));
  receivers[0].failed(new ScreenDecodeError());
  await vi.advanceTimersByTimeAsync(180000);
  expect(port.viewsChanged).toHaveBeenLastCalledWith([
    expect.objectContaining({
      sourceId: "screen",
      error: "codec",
    }),
  ]);
  expect(
    channel.sent.filter((s) => s.type === "retry"),
  ).toHaveLength(0);
  expect(channel.sent.at(-1)).toMatchObject({
    type: "receiver-status",
    state: "unsupported",
  });
  channel.receive({ type: "stop", id: "hevc" });
  expect(port.viewsChanged).toHaveBeenLastCalledWith([]);
  session.reset();
});

it("does not retry a retired receiver when intentional replacement aborts pending connection work", async () => {
  const { session, channel, port } = setup();
  const servers = deferred<RTCIceServer[]>();
  port.loadIceServers.mockReturnValue(
    servers.promise as any,
  );
  channel.receive({
    type: "hello",
    receiveScreen: true,
    multiScreen: true,
  });
  channel.receive({
    type: "offer",
    id: "old",
    sourceId: "screen",
    sdp: "offer",
  });
  servers.resolve([]);
  await Promise.resolve();
  let reject!: (error: Error) => void;
  receivers[0].connected.mockImplementation(
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
  );
  await flush();
  channel.receive({ type: "stop", id: "old", retry: true });
  reject(new Error("Native screen closed"));
  await flush();
  expect(port.error).not.toHaveBeenCalled();
  expect(
    channel.sent.some((value) => value.type === "retry"),
  ).toBe(false);
  expect(port.viewsChanged).toHaveBeenLastCalledWith([
    { sourceId: "screen" },
  ]);
  session.reset();
});

it("retains source identity across transport retries and resets all receiver state on repeated rejoin", async () => {
  const { session, port } = setup();
  for (let cycle = 0; cycle < 5; cycle++) {
    const channel = new Channel();
    session.bind(channel as unknown as RTCDataChannel);
    channel.receive({
      type: "hello",
      receiveScreen: true,
      multiScreen: true,
    });
    channel.receive({
      type: "offer",
      id: `first-${cycle}`,
      sourceId: "screen",
      sdp: "offer",
    });
    await flush();
    const old = receivers.at(-1);
    old.failed(new Error("controlled disconnect"));
    channel.receive({
      type: "stop",
      id: `first-${cycle}`,
      retry: true,
    });
    expect(
      port.viewsChanged.mock.calls.at(-1)?.[0],
    ).toHaveLength(1);
    channel.receive({
      type: "offer",
      id: `second-${cycle}`,
      sourceId: "screen",
      sdp: "offer",
    });
    await flush();
    expect(port.viewsChanged).toHaveBeenLastCalledWith([
      { sourceId: "screen" },
    ]);
    session.reset();
    old.changed(mediaStream("late"));
    expect(port.viewsChanged).toHaveBeenLastCalledWith([]);
  }
});

it("restores the retry budget after stable decoding and stops a terminal codec failure", async () => {
  const { session, channel } = setup();
  const pub = { ...publication(), controlEligible: true };
  session.setPublication(pub);
  channel.receive({ type: "hello", receiveScreen: true });
  await flush();
  for (let cycle = 0; cycle < 6; cycle++) {
    const id = channel.sent
      .filter((s) => s.type === "offer")
      .at(-1).id;
    channel.receive({ type: "answer", id, sdp: "answer" });
    await flush();
    channel.receive({
      type: "receiver-status",
      id,
      state: "healthy",
    });
    channel.receive({ type: "retry", id });
    await vi.advanceTimersByTimeAsync(1000);
  }
  expect(pub.offer).toHaveBeenCalledTimes(7);
  const id = channel.sent
    .filter((s) => s.type === "offer")
    .at(-1).id;
  channel.receive({
    type: "receiver-status",
    id,
    state: "unsupported",
  });
  await session.refreshControlCapabilities(true);
  channel.receive({
    type: "hello",
    receiveScreen: true,
    remoteControl: { request: true, host: false },
  });
  await vi.advanceTimersByTimeAsync(180000);
  expect(pub.offer).toHaveBeenCalledTimes(7);
  session.setPublication();
  expect(channel.sent.at(-1)).toEqual({ type: "stop", id });
  session.reset();
});

it.each([true, false])(
  "rejoins HEVC publication five times with simulated decode support=%s and discards previous owners",
  async (supported) => {
    const { session, port } = setup();
    for (let cycle = 0; cycle < 5; cycle++) {
      const channel = new Channel();
      session.bind(channel as unknown as RTCDataChannel);
      channel.receive({
        type: "hello",
        receiveScreen: true,
        multiScreen: true,
      });
      channel.receive({
        type: "offer",
        id: `hevc-${cycle}`,
        sourceId: "same-live-capture",
        sdp: "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 104\r\na=rtpmap:104 H265/90000\r\n",
      });
      await flush();
      const receiver = receivers.at(-1);
      if (supported)
        receiver.changed(mediaStream(`decoded-${cycle}`));
      else receiver.failed(new ScreenDecodeError());
      expect(
        port.viewsChanged.mock.calls.at(-1)?.[0],
      ).toHaveLength(1);
      session.reset();
      receiver.changed(mediaStream("obsolete"));
      receiver.failed(new ScreenDecodeError());
      expect(port.viewsChanged).toHaveBeenLastCalledWith(
        [],
      );
      expect(
        channel.sent.some((s) => s.type === "retry"),
      ).toBe(false);
      expect(receiver.close).toHaveBeenCalled();
    }
  },
);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it.each(["backoff", "pending-offer", "failed-offers"])(
  "clears the retained remote card when sharing stops during %s",
  async (phase) => {
    const sender = setup();
    const receiver = setup();
    const pub = publication("screen");
    let delivered = 0;
    const deliver = async () => {
      for (const message of sender.channel.sent.slice(
        delivered,
      ))
        receiver.channel.receive(message);
      delivered = sender.channel.sent.length;
      await flush();
    };
    try {
      sender.channel.receive({
        type: "hello",
        receiveScreen: true,
      });
      sender.session.setPublication(pub);
      await flush();
      await deliver();
      const offer = sender.channel.sent.find(
        (value) => value.type === "offer",
      );
      const pending = deferred<string>();
      if (phase === "pending-offer")
        vi.mocked(pub.offer).mockReturnValueOnce(
          pending.promise,
        );
      if (phase === "failed-offers")
        vi.mocked(pub.offer).mockRejectedValue(
          new Error("Encoder unavailable"),
        );
      sender.channel.receive({
        type: "retry",
        id: offer.id,
      });
      if (phase !== "backoff")
        await vi.advanceTimersByTimeAsync(
          phase === "pending-offer" ? 1000 : 10000,
        );
      await deliver();
      expect(
        receiver.port.viewsChanged,
      ).toHaveBeenLastCalledWith([{ sourceId: "screen" }]);
      sender.session.setPublications([]);
      pending.resolve("late-offer");
      await vi.advanceTimersByTimeAsync(60000);
      await deliver();
      expect(
        receiver.port.viewsChanged,
      ).toHaveBeenLastCalledWith([]);
      expect(
        sender.channel.sent.filter(
          (value) => value.type === "offer",
        ),
      ).toHaveLength(1);
    } finally {
      sender.session.reset();
      receiver.session.reset();
    }
  },
);

describe("native screen control", () => {
  it("keeps control capabilities opt-in and forgets them on disconnect", async () => {
    const { session, channel } = setup();
    expect(channel.sent[0]).not.toHaveProperty(
      "remoteControl",
    );
    channel.receive({
      type: "hello",
      receiveScreen: true,
      remoteControl: { request: true, host: false },
    });
    await flush();
    expect(session.remoteControlCapabilities).toEqual({
      request: true,
      host: false,
    });
    session.reset();
    expect(
      session.remoteControlCapabilities,
    ).toBeUndefined();
  });
  it("malformed control capabilities do not break legacy screen sharing", async () => {
    const { session, channel } = setup();
    channel.receive({
      type: "hello",
      receiveScreen: true,
      remoteControl: { request: true, host: "true" },
    });
    await flush();
    expect(
      session.remoteControlCapabilities,
    ).toBeUndefined();
  });
  const ice = {
    candidate: "candidate:host",
    sdpMid: "0",
    sdpMLineIndex: 0,
  };
  it("sends the offer before early local ICE and applies remote ICE only after its answer", async () => {
    const { session, channel } = setup();
    const pub = {
      ...publication(),
      addIceCandidate: vi.fn(async () => {}),
    };
    const answered = deferred<void>();
    vi.mocked(pub.answer).mockReturnValue(answered.promise);
    vi.mocked(pub.offer).mockImplementation(
      async (_id, _servers, _relay, candidate) => {
        candidate?.(ice);
        return "trickle-offer";
      },
    );
    channel.receive({
      type: "hello",
      receiveScreen: true,
      trickleIce: true,
    });
    session.setPublication(pub);
    await flush();
    expect(
      channel.sent.map((message) => message.type),
    ).toEqual(["hello", "offer", "candidate"]);
    const offer = channel.sent[1];
    expect(offer.trickleIce).toBe(true);
    channel.receive({
      type: "answer",
      id: offer.id,
      sdp: "answer",
    });
    channel.receive({
      type: "candidate",
      id: offer.id,
      candidate: ice,
    });
    await flush();
    expect(pub.addIceCandidate).not.toHaveBeenCalled();
    answered.resolve();
    await flush();
    expect(pub.addIceCandidate).toHaveBeenCalledWith(
      offer.id,
      ice,
    );
    session.reset();
    channel.receive({
      type: "candidate",
      id: offer.id,
      candidate: ice,
    });
    expect(pub.addIceCandidate).toHaveBeenCalledTimes(1);
  });
  it("queues incoming ICE while credentials load and drops retired connection candidates", async () => {
    const { session, channel, port } = setup();
    const servers = deferred<RTCIceServer[]>();
    port.loadIceServers.mockReturnValue(
      servers.promise as any,
    );
    channel.receive({
      type: "hello",
      receiveScreen: true,
      trickleIce: true,
    });
    channel.receive({
      type: "offer",
      id: "incoming",
      sourceId: "screen",
      sdp: "offer",
      trickleIce: true,
    });
    channel.receive({
      type: "candidate",
      id: "incoming",
      candidate: ice,
    });
    expect(receivers).toHaveLength(0);
    servers.resolve([]);
    await flush();
    expect(
      receivers[0].addIceCandidate,
    ).toHaveBeenCalledWith(ice);
    receivers[0].candidate(ice);
    expect(
      channel.sent.slice(-2).map((message) => message.type),
    ).toEqual(["answer", "candidate"]);
    channel.receive({ type: "stop", id: "incoming" });
    channel.receive({
      type: "candidate",
      id: "incoming",
      candidate: ice,
    });
    await flush();
    expect(
      receivers[0].addIceCandidate,
    ).toHaveBeenCalledTimes(1);
    session.reset();
  });
  it("discards ICE queued behind a pending answer when sharing stops", async () => {
    const { session, channel } = setup();
    const pub = {
      ...publication(),
      addIceCandidate: vi.fn(async () => {}),
    };
    const answered = deferred<void>();
    vi.mocked(pub.answer).mockReturnValue(answered.promise);
    channel.receive({
      type: "hello",
      receiveScreen: true,
      trickleIce: true,
    });
    session.setPublication(pub);
    await flush();
    const offer = channel.sent.find(
      (message) => message.type === "offer",
    );
    channel.receive({
      type: "answer",
      id: offer.id,
      sdp: "answer",
    });
    channel.receive({
      type: "candidate",
      id: offer.id,
      candidate: ice,
    });
    session.setPublication();
    answered.resolve();
    await flush();
    expect(pub.addIceCandidate).not.toHaveBeenCalled();
    expect(pub.closePeer).toHaveBeenCalledWith(offer.id);
    session.reset();
  });
  it("does not start an encoder until the authenticated peer advertises support", async () => {
    const { session, channel } = setup();
    const pub = publication();
    session.setPublication(pub);
    await flush();
    expect(pub.offer).not.toHaveBeenCalled();
    channel.receive({ type: "hello", receiveScreen: true });
    await flush();
    const offer = channel.sent.find(
      (x) => x.type === "offer",
    );
    expect(offer.sourceId).toBe("selected-source");
    expect(pub.offer).toHaveBeenCalledWith(
      offer.id,
      [
        {
          urls: "turn:relay",
          username: "user",
          credential: "temporary",
        },
      ],
      true,
    );
    channel.receive({
      type: "answer",
      id: "old-peer",
      sdp: "stale",
    });
    await flush();
    expect(pub.answer).not.toHaveBeenCalled();
    channel.receive({
      type: "answer",
      id: offer.id,
      sdp: "valid",
    });
    await flush();
    expect(pub.answer).toHaveBeenCalledWith(
      offer.id,
      "valid",
    );
    session.reset();
  });
  it("closes an encoder whose offer completes after leaving and preserves capture for rejoin", async () => {
    const { session, channel } = setup();
    const pub = publication();
    const pending = deferred<string>();
    vi.mocked(pub.offer).mockReturnValue(pending.promise);
    session.setPublication(pub);
    channel.receive({ type: "hello", receiveScreen: true });
    await flush();
    const peerId = vi.mocked(pub.offer).mock.calls[0][0];
    session.reset();
    pending.resolve("late-offer");
    await flush();
    expect(
      channel.sent.some((x) => x.type === "offer"),
    ).toBe(false);
    expect(pub.closePeer).toHaveBeenLastCalledWith(peerId);
    const next = new Channel();
    session.bind(next as unknown as RTCDataChannel);
    next.receive({ type: "hello", receiveScreen: true });
    await flush();
    expect(pub.offer).toHaveBeenCalledTimes(2);
    session.reset();
  });
  it("replaces one remote screen using its own connection identity and relay credentials", async () => {
    const { session, channel, port } = setup();
    channel.receive({ type: "hello", receiveScreen: true });
    channel.receive({
      type: "offer",
      id: "first",
      sourceId: "one",
      sdp: "offer1",
    });
    await flush();
    expect(receivers[0].config.iceTransportPolicy).toBe(
      "relay",
    );
    channel.receive({
      type: "offer",
      id: "second",
      sourceId: "two",
      sdp: "offer2",
    });
    await flush();
    expect(receivers[0].close).toHaveBeenCalledOnce();
    channel.receive({ type: "stop", id: "first" });
    await flush();
    expect(receivers[1].close).not.toHaveBeenCalled();
    const stream = mediaStream("second");
    receivers[1].changed(stream);
    expect(port.changed).toHaveBeenLastCalledWith(stream);
    session.reset();
    expect(receivers[1].close).toHaveBeenCalledOnce();
    expect(port.changed).toHaveBeenLastCalledWith(null);
  });
  it("ignores a pending remote offer after control channel replacement", async () => {
    const { session, channel, port } = setup();
    const pending = deferred<RTCIceServer[]>();
    port.loadIceServers.mockReturnValue(
      pending.promise as any,
    );
    channel.receive({ type: "hello", receiveScreen: true });
    channel.receive({
      type: "offer",
      id: "old",
      sourceId: "one",
      sdp: "offer",
    });
    session.reset();
    pending.resolve([]);
    await flush();
    expect(receivers).toHaveLength(0);
  });
  it("bounds reconnect attempts and releases senders when answers never arrive", async () => {
    const { session, channel, port } = setup();
    const pub = publication();
    session.setPublication(pub);
    channel.receive({ type: "hello", receiveScreen: true });
    await flush();
    await vi.advanceTimersByTimeAsync(150000);
    expect(pub.offer).toHaveBeenCalledTimes(4);
    expect(pub.closePeer).toHaveBeenCalledTimes(4);
    expect(port.error).toHaveBeenCalled();
    session.reset();
  });
  it("adds multiple publications without restarting existing senders and retries only the failed source", async () => {
    const { session, channel } = setup();
    const first = publication("one"),
      second = publication("two");
    channel.receive({
      type: "hello",
      receiveScreen: true,
      multiScreen: true,
    });
    session.setPublications([first]);
    await flush();
    session.setPublications([first, second, second]);
    await flush();
    const offers = channel.sent.filter(
      (m) => m.type === "offer",
    );
    expect(offers.map((m) => m.sourceId)).toEqual([
      "one",
      "two",
    ]);
    expect(first.offer).toHaveBeenCalledOnce();
    expect(second.offer).toHaveBeenCalledOnce();
    channel.receive({
      type: "answer",
      id: offers[1].id,
      sdp: "answer-two",
    });
    await flush();
    expect(second.answer).toHaveBeenCalledWith(
      offers[1].id,
      "answer-two",
    );
    expect(first.answer).not.toHaveBeenCalled();
    channel.receive({ type: "retry", id: offers[0].id });
    await vi.advanceTimersByTimeAsync(1000);
    expect(first.offer).toHaveBeenCalledTimes(2);
    expect(second.closePeer).not.toHaveBeenCalled();
    session.setPublications([second]);
    channel.receive({ type: "retry", id: offers[0].id });
    await flush();
    expect(second.offer).toHaveBeenCalledOnce();
    expect(second.closePeer).not.toHaveBeenCalled();
    session.reset();
    expect(second.closePeer).toHaveBeenCalledOnce();
    const next = new Channel();
    session.bind(next as unknown as RTCDataChannel);
    next.receive({
      type: "hello",
      receiveScreen: true,
      multiScreen: true,
    });
    await flush();
    expect(second.offer).toHaveBeenCalledTimes(2);
    expect(first.offer).toHaveBeenCalledTimes(2);
    session.reset();
  });
  it("sends just one screen to a legacy peer and promotes the next after removal", async () => {
    const { session, channel } = setup();
    const first = publication("one"),
      second = publication("two");
    session.setPublications([first, second]);
    channel.receive({ type: "hello", receiveScreen: true });
    await flush();
    expect(first.offer).toHaveBeenCalledOnce();
    expect(second.offer).not.toHaveBeenCalled();
    session.setPublications([second]);
    await flush();
    expect(first.closePeer).toHaveBeenCalledOnce();
    expect(second.offer).toHaveBeenCalledOnce();
    session.reset();
  });
  it("combines remote screens with independent audio owners and preserves the other stream during replacement and stop", async () => {
    const { session, channel, port } = setup();
    channel.receive({
      type: "hello",
      receiveScreen: true,
      multiScreen: true,
    });
    for (const id of ["one", "two"]) {
      channel.receive({
        type: "offer",
        id,
        sourceId: id,
        sdp: "offer",
      });
      await flush();
      receivers.at(-1).changed(mediaStream(id));
    }
    const combined = port.changed.mock
      .lastCall![0] as MediaStream;
    expect(
      combined.getVideoTracks().map((t) => t.id),
    ).toEqual(["one", "two"]);
    for (const audio of combined.getAudioTracks())
      expect(getNativeScreenAudioOwner(audio)?.id).toBe(
        audio.id.replace("-audio", ""),
      );
    expect(receivers[0].close).not.toHaveBeenCalled();
    channel.receive({
      type: "offer",
      id: "replacement",
      sourceId: "one",
      sdp: "offer",
    });
    await flush();
    expect(receivers[0].close).toHaveBeenCalledOnce();
    expect(receivers[1].close).not.toHaveBeenCalled();
    const replacement = mediaStream("replacement");
    receivers[2].changed(replacement);
    // Delayed callbacks/stop from the retired connection cannot remove its replacement.
    receivers[0].changed(null);
    channel.receive({ type: "stop", id: "one" });
    expect(
      port.changed.mock.lastCall![0].getVideoTracks(),
    ).toHaveLength(2);
    channel.receive({ type: "stop", id: "two" });
    expect(port.changed).toHaveBeenLastCalledWith(
      replacement,
    );
    expect(receivers[2].close).not.toHaveBeenCalled();
    session.reset();
    expect(receivers[2].close).toHaveBeenCalledOnce();
  });
  it("ignores a late offer from a removed source without closing another sender", async () => {
    const { session, channel } = setup();
    const first = publication("one"),
      second = publication("two");
    const pending = deferred<string>();
    vi.mocked(first.offer).mockReturnValue(pending.promise);
    channel.receive({
      type: "hello",
      receiveScreen: true,
      multiScreen: true,
    });
    session.setPublications([first, second]);
    await flush();
    session.setPublications([second]);
    pending.resolve("late");
    await flush();
    expect(
      channel.sent
        .filter((m) => m.type === "offer")
        .map((m) => m.sourceId),
    ).toEqual(["two"]);
    expect(second.closePeer).not.toHaveBeenCalled();
    session.reset();
  });
  it("releases every removed sender even when the control channel cannot send stop", async () => {
    const { session, channel, port } = setup();
    const first = publication("one"),
      second = publication("two");
    channel.receive({
      type: "hello",
      receiveScreen: true,
      multiScreen: true,
    });
    session.setPublications([first, second]);
    await flush();
    channel.bufferedAmount = 262145;
    expect(() => session.setPublications([])).not.toThrow();
    expect(first.closePeer).toHaveBeenCalledOnce();
    expect(second.closePeer).toHaveBeenCalledOnce();
    expect(port.error).toHaveBeenCalledTimes(2);
    session.reset();
  });
  it("rejects malformed and oversized signals", () => {
    for (const input of [
      null,
      "{",
      "x".repeat(65537),
      JSON.stringify({ type: "offer", id: "x", sdp: "s" }),
      JSON.stringify({ type: "answer", id: "x", sdp: 123 }),
      JSON.stringify({
        type: "candidate",
        id: "x",
        candidate: { candidate: "x" },
      }),
      JSON.stringify({
        type: "candidate",
        id: "x",
        candidate: {
          candidate: "x".repeat(4097),
          sdpMid: "0",
        },
      }),
      JSON.stringify({
        type: "candidate",
        id: "x",
        candidate: { candidate: "x", sdpMLineIndex: -1 },
      }),
    ])
      expect(parseScreenSignal(input)).toBeUndefined();
  });
});

it("adds native control only for an eligible display and a capable authenticated peer", async () => {
  const context = vi.fn(async () => ({
    ownerId: "room",
    peerGeneration: "peer",
    clientId: "client",
  }));
  const s = new NativeScreenSession({
    controlCapabilities: { request: true, host: true },
    controlContext: context,
    loadIceServers: async () => [],
    relayOnly: () => false,
    changed: () => {},
    error: vi.fn(),
  });
  const display = {
    ...publication("display"),
    controlEligible: true,
  };
  const window = publication("window");
  s.setPublications([display, window]);
  const channel = new Channel();
  s.bind(channel as unknown as RTCDataChannel);
  channel.receive({
    type: "hello",
    receiveScreen: true,
    multiScreen: true,
    remoteControl: { request: true, host: false },
  });
  await flush();
  expect(display.offer).toHaveBeenCalledWith(
    expect.any(String),
    [],
    false,
    undefined,
    {
      ownerId: "room",
      peerGeneration: "peer",
      clientId: "client",
      sourceId: "display",
    },
  );
  expect(window.offer).toHaveBeenCalledWith(
    expect.any(String),
    [],
    false,
  );
  expect(
    channel.sent
      .filter((v) => v.type === "offer")
      .map((v) => [v.sourceId, v.control]),
  ).toEqual(
    expect.arrayContaining([
      ["display", true],
      ["window", undefined],
    ]),
  );
  s.reset();
  expect(display.closePeer).toHaveBeenCalledTimes(1);
  expect(window.closePeer).toHaveBeenCalledTimes(1);
});

it("announces local control capabilities before publishing when the peer hello arrives during initialization", async () => {
  const capabilities = deferred<{
    request: boolean;
    host: boolean;
  }>();
  const session = new NativeScreenSession({
    loadControlCapabilities: () => capabilities.promise,
    controlContext: async () => ({
      ownerId: "owner",
      peerGeneration: "peer",
      clientId: "viewer",
    }),
    loadIceServers: async () => [],
    relayOnly: () => false,
    changed: vi.fn(),
    error: vi.fn(),
  });
  const pub = { ...publication(), controlEligible: true };
  session.setPublication(pub);
  const channel = new Channel();
  session.bind(channel as unknown as RTCDataChannel);
  channel.receive({
    type: "hello",
    receiveScreen: true,
    remoteControl: { request: true, host: false },
  });
  await flush();
  expect(pub.offer).not.toHaveBeenCalled();
  capabilities.resolve({ request: true, host: true });
  await flush();
  expect(channel.sent.map((v) => v.type)).toEqual([
    "hello",
    "offer",
  ]);
  expect(channel.sent[0].remoteControl.host).toBe(true);
  expect(channel.sent[1].control).toBe(true);
  session.reset();
});

it("adds control to an existing display when the viewer advertises request support later", async () => {
  const session = new NativeScreenSession({
    controlCapabilities: { request: true, host: true },
    controlContext: async () => ({
      ownerId: "owner",
      peerGeneration: "peer",
      clientId: "viewer",
    }),
    loadIceServers: async () => [],
    relayOnly: () => false,
    changed: vi.fn(),
    error: vi.fn(),
  });
  const display = {
    ...publication("display"),
    controlEligible: true,
  };
  const window = publication("window");
  const channel = new Channel();
  session.bind(channel as unknown as RTCDataChannel);
  session.setPublications([display, window]);
  channel.receive({
    type: "hello",
    receiveScreen: true,
    multiScreen: true,
  });
  await flush();
  const first = channel.sent.find(
    (v) => v.type === "offer" && v.sourceId === "display",
  );
  expect(first.control).toBeUndefined();
  const hello = {
    type: "hello",
    receiveScreen: true,
    multiScreen: true,
    remoteControl: { request: true, host: false },
  };
  channel.receive(hello);
  await flush();
  expect(display.closePeer).toHaveBeenCalledWith(first.id);
  expect(
    channel.sent
      .filter(
        (v) =>
          v.type === "offer" && v.sourceId === "display",
      )
      .at(-1).control,
  ).toBe(true);
  expect(window.offer).toHaveBeenCalledOnce();
  channel.receive(hello);
  await flush();
  expect(display.offer).toHaveBeenCalledTimes(2);
  session.reset();
});

it("does not attach input after owner preparation finishes for an obsolete channel", async () => {
  const pending = deferred<{
    ownerId: string;
    peerGeneration: string;
    clientId: string;
  }>();
  const s = new NativeScreenSession({
    controlCapabilities: { request: true, host: true },
    controlContext: () => pending.promise,
    loadIceServers: async () => [],
    relayOnly: () => false,
    changed: () => {},
    error: vi.fn(),
  });
  const display = {
    ...publication("display"),
    controlEligible: true,
  };
  s.setPublication(display);
  const channel = new Channel();
  s.bind(channel as unknown as RTCDataChannel);
  channel.receive({
    type: "hello",
    receiveScreen: true,
    remoteControl: { request: true, host: false },
  });
  await flush();
  s.reset();
  pending.resolve({
    ownerId: "old-room",
    peerGeneration: "old-peer",
    clientId: "client",
  });
  await flush();
  expect(display.offer).not.toHaveBeenCalled();
  expect(
    channel.sent.filter((v) => v.type === "offer"),
  ).toEqual([]);
});

it("ignores a stale capability read after a newer permission refresh", async () => {
  const initial = deferred<{
    request: boolean;
    host: boolean;
  }>();
  const load = vi
    .fn()
    .mockReturnValueOnce(initial.promise)
    .mockResolvedValue({ request: true, host: false });
  const context = vi.fn(async () => undefined);
  const session = new NativeScreenSession({
    loadControlCapabilities: load,
    controlContext: context,
    loadIceServers: async () => [],
    relayOnly: () => false,
    changed: vi.fn(),
    error: vi.fn(),
  });
  const channel = new Channel();
  session.bind(channel as unknown as RTCDataChannel);
  session.setPublication({
    ...publication(),
    controlEligible: true,
  });
  channel.receive({
    type: "hello",
    receiveScreen: true,
    remoteControl: { request: true, host: false },
  });
  await session.refreshControlCapabilities();
  await flush();
  initial.resolve({ request: true, host: true });
  await flush();
  expect(
    channel.sent.filter((v) => v.type === "hello"),
  ).toEqual([
    expect.objectContaining({
      remoteControl: { request: true, host: false },
    }),
  ]);
  expect(
    channel.sent.find((v) => v.type === "offer").control,
  ).toBeUndefined();
  expect(context).not.toHaveBeenCalled();
  session.reset();
});

it("retains an owner rebind when a newer permission refresh overtakes it", async () => {
  const capabilities = { request: true, host: true };
  const load = vi.fn(async () => capabilities);
  const session = new NativeScreenSession({
    loadControlCapabilities: load,
    loadIceServers: async () => [],
    relayOnly: () => false,
    changed: vi.fn(),
    error: vi.fn(),
  });
  const channel = new Channel();
  const pub = { ...publication(), controlEligible: true };
  session.bind(channel as unknown as RTCDataChannel);
  session.setPublication(pub);
  channel.receive({ type: "hello", receiveScreen: true });
  await flush();
  const pending = deferred<typeof capabilities>();
  load.mockReturnValueOnce(pending.promise);
  const rebind = session.refreshControlCapabilities(true);
  try {
    await session.refreshControlCapabilities();
    await flush();
    expect(pub.closePeer).toHaveBeenCalledOnce();
    expect(pub.offer).toHaveBeenCalledTimes(2);
    pending.resolve(capabilities);
    await rebind;
    expect(pub.offer).toHaveBeenCalledTimes(2);
  } finally {
    pending.resolve(capabilities);
    session.reset();
  }
});

it("retries a failed control transport for the same shared source and binds a fresh controller", async () => {
  const { session, channel, port } = setup();
  channel.receive({
    type: "hello",
    receiveScreen: true,
    remoteControl: { request: true, host: true },
  });
  channel.receive({
    type: "offer",
    id: "first",
    sourceId: "display",
    sdp: "offer",
    control: true,
  });
  await flush();
  const first = mediaStream("first-video");
  receivers[0].stream = first;
  receivers[0].changed(first);
  const controller = session.getRemoteControl(
    first.getVideoTracks()[0],
  );
  expect(controller).toBeDefined();
  receivers[0].failed(
    new Error("Native control connection ended"),
  );
  expect(controller?.state()).toBe("unavailable");
  expect(channel.sent.at(-1)).toEqual({
    type: "retry",
    id: "first",
  });
  channel.receive({
    type: "offer",
    id: "second",
    sourceId: "display",
    sdp: "replacement",
    control: true,
  });
  await flush();
  const replacement = mediaStream("second-video");
  receivers[1].stream = replacement;
  receivers[1].changed(replacement);
  expect(
    session.getRemoteControl(
      replacement.getVideoTracks()[0],
    ),
  ).toBeDefined();
  expect(
    session.getRemoteControl(
      replacement.getVideoTracks()[0],
    ),
  ).not.toBe(controller);
  expect(port.changed).toHaveBeenLastCalledWith(
    replacement,
  );
  expect(channel.readyState).toBe("open");
  session.reset();
});

it("refreshes per-peer control capabilities and republishes the same capture without control for a blocked peer", async () => {
  let allowed = true;
  const port = {
    loadIceServers: async () => [],
    relayOnly: () => false,
    changed: vi.fn(),
    error: vi.fn(),
    loadControlCapabilities: async () => ({
      request: true,
      host: allowed,
    }),
    controlContext: async () =>
      allowed
        ? {
            ownerId: "owner",
            clientId: "alice",
            peerGeneration: "peer",
          }
        : undefined,
    requestScreen: vi.fn(async () => "screen"),
  };
  const session = new NativeScreenSession(port);
  const channel = new Channel();
  session.bind(channel as unknown as RTCDataChannel);
  channel.receive({
    type: "hello",
    receiveScreen: true,
    remoteControl: { request: true, host: false },
  });
  const pub = { ...publication(), controlEligible: true };
  session.setPublication(pub);
  await flush();
  expect(
    channel.sent.find((signal) => signal.type === "hello")
      .requestScreen,
  ).toBe(true);
  expect(
    channel.sent.find((signal) => signal.type === "offer")
      .control,
  ).toBe(true);
  allowed = false;
  await session.refreshControlCapabilities();
  await flush();
  expect(
    channel.sent
      .filter((signal) => signal.type === "hello")
      .at(-1),
  ).toMatchObject({ remoteControl: { host: false } });
  expect(
    channel.sent
      .filter((signal) => signal.type === "hello")
      .at(-1),
  ).not.toHaveProperty("requestScreen");
  expect(
    channel.sent
      .filter((signal) => signal.type === "offer")
      .at(-1),
  ).not.toHaveProperty("control");
  channel.receive({
    type: "control-request",
    id: "blocked",
  });
  await flush();
  expect(port.requestScreen).not.toHaveBeenCalled();
  expect(channel.sent.at(-1)).toEqual({
    type: "control-result",
    id: "blocked",
  });
  allowed = true;
  await session.refreshControlCapabilities();
  await flush();
  expect(
    channel.sent
      .filter((signal) => signal.type === "offer")
      .at(-1),
  ).toMatchObject({
    control: true,
    sourceId: pub.sourceId,
  });
  session.reset();
});

it("cancels an avatar approval before it can return a stale source and clears capabilities on reset", async () => {
  const pending = deferred<string | undefined>();
  let signal: AbortSignal;
  const port = {
    loadIceServers: async () => [],
    relayOnly: () => false,
    changed: vi.fn(),
    error: vi.fn(),
    controlCapabilities: { host: true, request: true },
    requestScreen: vi.fn((abort: AbortSignal) => {
      signal = abort;
      return pending.promise;
    }),
    cancelScreenRequest: vi.fn(),
  };
  const session = new NativeScreenSession(port);
  const channel = new Channel();
  session.bind(channel as unknown as RTCDataChannel);
  channel.receive({
    type: "hello",
    receiveScreen: true,
    requestScreen: true,
    remoteControl: { host: true, request: true },
  });
  expect(session.screenControl.state()).toBe("viewing");
  channel.receive({ type: "control-request", id: "first" });
  await flush();
  channel.receive({ type: "control-cancel", id: "other" });
  expect(signal!.aborted).toBe(false);
  channel.receive({ type: "control-cancel", id: "first" });
  expect(signal!.aborted).toBe(true);
  pending.resolve("stale-screen");
  await flush();
  expect(
    channel.sent.some(
      (value) => value.type === "control-result",
    ),
  ).toBe(false);
  session.reset();
  expect(session.screenControl.state()).toBe("unavailable");
});

it.each(["stop", "failure"] as const)(
  "allows a new avatar request after the controlled screen ends through %s",
  async (reason) => {
    const { session, channel } = setup();
    channel.receive({
      type: "hello",
      receiveScreen: true,
      requestScreen: true,
      remoteControl: { host: true, request: true },
    });
    session.screenControl.request();
    const request = channel.sent.at(-1);
    channel.receive({
      type: "offer",
      id: "first",
      sourceId: "display",
      sdp: "offer",
      control: true,
    });
    await flush();
    const stream = mediaStream("first-video");
    receivers[0].stream = stream;
    receivers[0].changed(stream);
    const pointer = session.getRemoteControl(
      stream.getVideoTracks()[0],
    )!;
    const state = vi
      .spyOn(pointer, "state")
      .mockReturnValue("viewing");
    const start = vi
      .spyOn(pointer, "request")
      .mockImplementation(() => {
        state.mockReturnValue("active");
        pointer.dispatchEvent(new Event("change"));
      });
    channel.receive({
      type: "control-result",
      id: request.id,
      sourceId: "display",
    });
    expect(session.screenControl.state()).toBe("active");
    state.mockRestore();
    start.mockRestore();
    if (reason === "stop")
      channel.receive({ type: "stop", id: "first" });
    else receivers[0].failed(new Error("connection ended"));
    expect(pointer.state()).toBe("unavailable");
    expect(session.screenControl.state()).toBe("viewing");
    expect(channel.readyState).toBe("open");
    session.screenControl.request();
    expect(channel.sent.at(-1)).toEqual({
      type: "control-request",
      id: expect.any(String),
    });
    expect(channel.sent.at(-1).id).not.toBe(request.id);
    pointer.dispatchEvent(new Event("change"));
    channel.receive({ type: "stop", id: "first" });
    expect(session.screenControl.state()).toBe(
      "requesting",
    );
    channel.receive({
      type: "hello",
      receiveScreen: true,
      remoteControl: { host: false, request: true },
    });
    expect(session.screenControl.state()).toBe(
      "unavailable",
    );
    session.reset();
  },
);
