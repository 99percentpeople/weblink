// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { PeerSessionMediaController } from "@/libs/domain/session-media";

class Track extends EventTarget {
  readyState: MediaStreamTrackState = "live";
  muted = false;
  readonly stop = vi.fn(() => {
    this.readyState = "ended";
  });
  constructor(
    readonly kind: "audio" | "video",
    readonly id: string,
  ) {
    super();
  }
  end() {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  }
}
let streamId = 0;
class Stream extends EventTarget {
  readonly id = `stream-${++streamId}`;
  private tracks: MediaStreamTrack[];
  constructor(tracks: MediaStreamTrack[] = []) {
    super();
    this.tracks = [...tracks];
  }
  getTracks() {
    return [...this.tracks];
  }
  getVideoTracks() {
    return this.tracks.filter(
      (track) => track.kind === "video",
    );
  }
  getAudioTracks() {
    return this.tracks.filter(
      (track) => track.kind === "audio",
    );
  }
  addTrack(track: MediaStreamTrack) {
    if (!this.tracks.includes(track))
      this.tracks.push(track);
  }
  removeTrack(track: MediaStreamTrack) {
    this.tracks = this.tracks.filter(
      (candidate) => candidate !== track,
    );
  }
  remoteRemove(track: MediaStreamTrack) {
    this.removeTrack(track);
    this.dispatchEvent(
      Object.assign(new Event("removetrack"), { track }),
    );
  }
}
class PeerConnection extends EventTarget {
  connectionState = "connected";
  senders: { track: MediaStreamTrack | null }[] = [];
  readonly addTrack = vi.fn(
    (track: MediaStreamTrack, _stream: MediaStream) => {
      if (
        this.senders.some(
          (sender) => sender.track === track,
        )
      )
        throw new Error("duplicate sender");
      const sender = { track };
      this.senders.push(sender);
      return sender as RTCRtpSender;
    },
  );
  readonly removeTrack = vi.fn((sender: RTCRtpSender) => {
    Object.assign(sender, { track: null });
  });
  readonly addTransceiver = vi.fn();
  getSenders() {
    return this.senders;
  }
  getTransceivers() {
    return [];
  }
  receive(track: Track, streams: Stream[] = []) {
    this.dispatchEvent(
      Object.assign(new Event("track"), {
        track,
        streams,
        receiver: {},
      }),
    );
  }
}
const asTrack = (track: Track) =>
  track as unknown as MediaStreamTrack;
const media = (...tracks: Track[]) =>
  new Stream(tracks.map(asTrack));
const asStream = (stream: Stream) =>
  stream as unknown as MediaStream;
const asPc = (pc: PeerConnection) =>
  pc as unknown as RTCPeerConnection;

function setup() {
  const state = { pc: null as PeerConnection | null };
  const remote =
    vi.fn<(stream: MediaStream | null) => void>();
  const renegotiate = vi.fn();
  const notify = vi.fn();
  const controller = new PeerSessionMediaController({
    targetClientId: () => "peer",
    getPeerConnection: () =>
      state.pc ? asPc(state.pc) : null,
    getCodecOptions: () => ({
      preferredVideoCodec: null,
      preferredAudioCodec: null,
    }),
    notifyStreamState: notify,
    renegotiate,
    onRemoteStreamChange: remote,
  });
  const bind = (pc = new PeerConnection()) => {
    state.pc = pc;
    const lifetime = new AbortController();
    controller.bindConnection(asPc(pc), lifetime.signal);
    return { pc, lifetime };
  };
  return {
    state,
    controller,
    remote,
    renegotiate,
    notify,
    bind,
  };
}

beforeEach(() => {
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("RTCRtpSender", undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("multiple video sources in a peer session", () => {
  it("binds camera, screen and microphone and removes only a screen that ends", () => {
    const camera = new Track("video", "camera"),
      screen = new Track("video", "screen"),
      mic = new Track("audio", "mic");
    const { controller, bind, renegotiate } = setup();
    controller.setStream(
      asStream(media(camera, screen, mic)),
    );
    const { pc } = bind();
    expect(
      pc.getSenders().map((sender) => sender.track),
    ).toEqual([camera, screen, mic]);
    expect(renegotiate).not.toHaveBeenCalled();
    screen.end();
    expect(pc.removeTrack).toHaveBeenCalledTimes(1);
    expect(
      pc
        .getSenders()
        .filter((sender) => sender.track)
        .map((sender) => sender.track),
    ).toEqual([camera, mic]);
    expect(camera.stop).not.toHaveBeenCalled();
    expect(mic.stop).not.toHaveBeenCalled();
    expect(renegotiate).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("retains camera/audio senders when replacing a container that removes only the screen", () => {
    const camera = new Track("video", "camera"),
      screen = new Track("video", "screen"),
      mic = new Track("audio", "mic");
    const { controller, bind } = setup();
    const first = media(camera, screen, mic);
    controller.setStream(asStream(first));
    const { pc } = bind();
    const [cameraSender, , micSender] = pc.getSenders();
    controller.setStream(asStream(media(camera, mic)));
    expect(pc.addTrack).toHaveBeenCalledTimes(3);
    expect(
      pc.getSenders().filter((sender) => sender.track),
    ).toEqual([cameraSender, micSender]);
    expect(first.getTracks()).toHaveLength(3);
    for (const track of [camera, screen, mic])
      expect(track.stop).not.toHaveBeenCalled();
    screen.end();
    expect(pc.removeTrack).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("reconciles explicit mutations of the same container and watches dynamically added tracks", () => {
    const camera = new Track("video", "camera"),
      screen = new Track("video", "screen"),
      mic = new Track("audio", "mic");
    const { controller, bind } = setup();
    const stream = media(camera, mic);
    controller.setStream(asStream(stream));
    const { pc } = bind();
    stream.addTrack(asTrack(screen));
    controller.setStream(asStream(stream));
    expect(pc.addTrack).toHaveBeenCalledTimes(3);
    stream.removeTrack(asTrack(camera));
    controller.setStream(asStream(stream));
    expect(pc.removeTrack).toHaveBeenCalledTimes(1);
    screen.end();
    expect(pc.removeTrack).toHaveBeenCalledTimes(2);
    expect(
      pc
        .getSenders()
        .filter((sender) => sender.track)
        .map((sender) => sender.track),
    ).toEqual([mic]);
    controller.dispose();
  });

  it("borrows local tracks without stopping a capture shared with another peer", () => {
    const camera = new Track("video", "camera"),
      screen = new Track("video", "screen"),
      mic = new Track("audio", "mic");
    const stream = media(camera, screen, mic);
    const first = setup(),
      second = setup();
    first.controller.setStream(asStream(stream));
    second.controller.setStream(asStream(stream));
    const a = first.bind(),
      b = second.bind();
    first.controller.setStream(null);
    first.controller.dispose();
    expect(a.pc.removeTrack).toHaveBeenCalledTimes(3);
    expect(b.pc.removeTrack).not.toHaveBeenCalled();
    expect(stream.getTracks()).toHaveLength(3);
    for (const track of [camera, screen, mic])
      expect(track.stop).not.toHaveBeenCalled();
    second.controller.dispose();
  });

  it("aggregates different remote source streams and publishes new snapshots", () => {
    const camera = new Track("video", "camera"),
      screen = new Track("video", "screen"),
      mic = new Track("audio", "mic");
    const cameraStream = media(camera, mic),
      screenStream = media(screen);
    const { controller, bind, remote } = setup();
    const { pc } = bind();
    pc.receive(camera, [cameraStream]);
    const firstSnapshot = remote.mock.lastCall![0];
    pc.receive(mic, [cameraStream]);
    pc.receive(screen, [screenStream]);
    const combined = remote.mock.lastCall![0]!;
    expect(combined.getTracks()).toEqual([
      camera,
      mic,
      screen,
    ]);
    expect(combined).not.toBe(firstSnapshot);
    expect(camera.stop).not.toHaveBeenCalled();
    screenStream.remoteRemove(asTrack(screen));
    expect(remote.mock.lastCall![0]!.getTracks()).toEqual([
      camera,
      mic,
    ]);
    expect(screen.stop).not.toHaveBeenCalled();
    mic.end();
    expect(remote.mock.lastCall![0]!.getTracks()).toEqual([
      camera,
    ]);
    controller.dispose();
  });

  it("supports streamless remote tracks and preserves temporary mute/unmute", () => {
    const screen = new Track("video", "screen"),
      mic = new Track("audio", "mic");
    const { controller, bind, remote } = setup();
    const { pc } = bind();
    pc.receive(screen);
    pc.receive(mic);
    screen.muted = true;
    screen.dispatchEvent(new Event("mute"));
    expect(remote.mock.lastCall![0]!.getTracks()).toEqual([
      screen,
      mic,
    ]);
    screen.muted = false;
    screen.dispatchEvent(new Event("unmute"));
    expect(
      remote.mock.lastCall![0]!.getVideoTracks(),
    ).toEqual([screen]);
    screen.end();
    expect(remote.mock.lastCall![0]!.getTracks()).toEqual([
      mic,
    ]);
    mic.end();
    expect(remote.mock.lastCall![0]).toBeNull();
    controller.dispose();
  });

  it("ignores old source removal after a receiver track is re-associated", () => {
    const camera = new Track("video", "camera");
    const previous = media(camera),
      replacement = media(camera);
    const { controller, bind, remote } = setup();
    const { pc } = bind();
    pc.receive(camera, [previous]);
    pc.receive(camera, [replacement]);
    previous.remoteRemove(asTrack(camera));
    expect(remote.mock.lastCall![0]!.getTracks()).toEqual([
      camera,
    ]);
    replacement.remoteRemove(asTrack(camera));
    expect(remote.mock.lastCall![0]).toBeNull();
    pc.receive(camera, [replacement]);
    expect(remote.mock.lastCall![0]!.getTracks()).toEqual([
      camera,
    ]);
    controller.dispose();
  });

  it("rebinds all local tracks after reconnect and retires old remote events", () => {
    const camera = new Track("video", "camera"),
      screen = new Track("video", "screen");
    const remoteTrack = new Track("video", "remote");
    const { controller, bind, remote } = setup();
    controller.setStream(asStream(media(camera, screen)));
    const first = bind();
    first.pc.receive(remoteTrack, [media(remoteTrack)]);
    first.lifetime.abort();
    controller.resetConnection();
    expect(remoteTrack.stop).toHaveBeenCalledTimes(1);
    expect(remote.mock.lastCall![0]).toBeNull();
    const second = bind();
    expect(second.pc.addTrack).toHaveBeenCalledTimes(2);
    const count = remote.mock.calls.length;
    first.pc.receive(new Track("video", "late"));
    expect(remote).toHaveBeenCalledTimes(count);
    screen.end();
    expect(first.pc.removeTrack).not.toHaveBeenCalled();
    expect(second.pc.removeTrack).toHaveBeenCalledTimes(1);
    controller.dispose();
    camera.end();
    expect(second.pc.removeTrack).toHaveBeenCalledTimes(1);
    expect(camera.stop).not.toHaveBeenCalled();
  });

  it("does not duplicate senders on a repeated binding of the same connection", () => {
    const camera = new Track("video", "camera");
    const { controller, bind } = setup();
    controller.setStream(asStream(media(camera)));
    const { pc, lifetime } = bind();
    controller.bindConnection(asPc(pc), lifetime.signal);
    expect(pc.addTrack).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it("retains senders added before the connection event listeners are bound", () => {
    const camera = new Track("video", "camera"),
      screen = new Track("video", "screen"),
      mic = new Track("audio", "mic");
    const { controller, state, bind } = setup();
    state.pc = new PeerConnection();
    controller.setStream(
      asStream(media(camera, screen, mic)),
    );
    const { pc } = bind(state.pc);
    expect(pc.addTrack).toHaveBeenCalledTimes(3);
    controller.setStream(asStream(media(camera, mic)));
    expect(pc.removeTrack).toHaveBeenCalledTimes(1);
    expect(
      pc
        .getSenders()
        .filter((sender) => sender.track)
        .map((sender) => sender.track),
    ).toEqual([camera, mic]);
    controller.dispose();
  });

  it("retires the old connection when local media reaches a replacement before binding", () => {
    const camera = new Track("video", "camera");
    const previousRemote = new Track("video", "old-remote");
    const nextRemote = new Track("video", "new-remote");
    const { controller, state, bind, remote } = setup();
    controller.setStream(asStream(media(camera)));
    const first = bind();
    first.pc.receive(previousRemote, [
      media(previousRemote),
    ]);
    state.pc = new PeerConnection();
    controller.setStream(asStream(media(camera)));
    const second = bind(state.pc);
    expect(previousRemote.stop).toHaveBeenCalledTimes(1);
    expect(second.pc.addTrack).toHaveBeenCalledTimes(1);
    const callCount = remote.mock.calls.length;
    first.pc.receive(new Track("video", "late"));
    expect(remote).toHaveBeenCalledTimes(callCount);
    second.pc.receive(nextRemote, [media(nextRemote)]);
    expect(remote.mock.lastCall![0]!.getTracks()).toEqual([
      nextRemote,
    ]);
    expect(camera.stop).not.toHaveBeenCalled();
    controller.dispose();
  });
});
