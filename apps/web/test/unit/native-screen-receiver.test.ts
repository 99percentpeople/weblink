import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { ScreenReceiver } from "@/libs/domain/native-screen/receiver";
import type { RemotePointer } from "@/libs/domain/remote-control/pointer";

class Stream {
  tracks: any[] = [];
  constructor(tracks: any[] = []) {
    this.tracks = [...tracks];
  }
  addTrack(track: any) {
    this.tracks.push(track);
  }
  getTracks() {
    return this.tracks;
  }
}
class Connection extends EventTarget {
  connectionState = "connected";
  close = vi.fn();
}
beforeEach(() => {
  vi.stubGlobal("RTCPeerConnection", Connection);
  vi.stubGlobal("MediaStream", Stream);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const announce = (
  screen: ScreenReceiver,
  kind: string,
  receiver: object,
) => {
  const track = Object.assign(new EventTarget(), {
    kind,
    stop: vi.fn(),
  });
  const event = Object.assign(new Event("track"), {
    track,
    receiver,
  });
  screen.pc.dispatchEvent(event);
  return track;
};
it("requests low playout delay for both native video and its synchronized system audio", () => {
  const changed = vi.fn(),
    failed = vi.fn();
  const screen = new ScreenReceiver({}, changed, failed);
  const video = {
    jitterBufferTarget: null,
    playoutDelayHint: 0.4,
  };
  const audio = {
    jitterBufferTarget: 100,
    playoutDelayHint: 0.2,
  };
  const v = announce(screen, "video", video),
    a = announce(screen, "audio", audio);
  expect(video).toEqual({
    jitterBufferTarget: 0,
    playoutDelayHint: 0,
  });
  expect(audio).toEqual({
    jitterBufferTarget: 0,
    playoutDelayHint: 0,
  });
  expect(changed).toHaveBeenLastCalledWith(
    expect.objectContaining({ tracks: [v, a] }),
  );
  screen.close();
  expect(v.stop).toHaveBeenCalledOnce();
  expect(a.stop).toHaveBeenCalledOnce();
  expect(failed).not.toHaveBeenCalled();
});
it("still receives media when a WebView lacks hints or rejects an experimental setter", () => {
  const screen = new ScreenReceiver({}, vi.fn(), vi.fn());
  const receiver = {
    set jitterBufferTarget(_value: number) {
      throw new Error("unsupported");
    },
    playoutDelayHint: 0.5,
  };
  const video = announce(screen, "video", receiver);
  const audio = announce(screen, "audio", {});
  expect(receiver.playoutDelayHint).toBe(0);
  expect(screen.stream.getTracks()).toEqual([video, audio]);
  screen.close();
});

it("keeps control on a transient ICE disconnect and closes only after the recovery deadline", () => {
  vi.useFakeTimers();
  const control = Object.assign(new EventTarget(), {
    close: vi.fn(),
  });
  const failed = vi.fn();
  const screen = new ScreenReceiver(
    {},
    vi.fn(),
    failed,
    undefined,
    control as unknown as RemotePointer,
  );
  const pc = screen.pc as unknown as Connection;
  pc.connectionState = "disconnected";
  pc.dispatchEvent(new Event("connectionstatechange"));
  vi.advanceTimersByTime(3000);
  expect(control.close).not.toHaveBeenCalled();
  pc.connectionState = "connected";
  pc.dispatchEvent(new Event("connectionstatechange"));
  vi.advanceTimersByTime(9000);
  expect(failed).not.toHaveBeenCalled();
  pc.connectionState = "disconnected";
  pc.dispatchEvent(new Event("connectionstatechange"));
  vi.advanceTimersByTime(8000);
  expect(control.close).toHaveBeenCalledOnce();
  expect(failed).toHaveBeenCalledOnce();
});
it("reports a terminal control channel failure to the media retry owner, but not intentional teardown", () => {
  const control = Object.assign(new EventTarget(), {
    close: vi.fn(),
  });
  const failed = vi.fn();
  const screen = new ScreenReceiver(
    {},
    vi.fn(),
    failed,
    undefined,
    control as unknown as RemotePointer,
  );
  control.dispatchEvent(new Event("transporterror"));
  expect(failed).toHaveBeenCalledOnce();
  expect(screen.pc.close).toHaveBeenCalledOnce();
  screen.close();
  control.dispatchEvent(new Event("transporterror"));
  expect(failed).toHaveBeenCalledOnce();
  const intentional = new ScreenReceiver(
    {},
    vi.fn(),
    failed,
    undefined,
    control as unknown as RemotePointer,
  );
  intentional.close();
  expect(failed).toHaveBeenCalledOnce();
});

it.each([
  "m=video 0 UDP/TLS/RTP/SAVPF 104\r\na=inactive\r\n",
  "m=video 9 UDP/TLS/RTP/SAVPF 104\r\na=inactive\r\n",
  "m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n",
])(
  "rejects an incompatible video answer before waiting for ICE: %s",
  async (sdp) => {
    const screen = new ScreenReceiver({}, vi.fn(), vi.fn());
    Object.assign(screen.pc, {
      setRemoteDescription: vi.fn(async () => {}),
      createAnswer: vi.fn(async () => ({
        type: "answer",
        sdp,
      })),
      setLocalDescription: vi.fn(),
    });
    await expect(
      screen.answer(
        "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 104\r\na=rtpmap:104 H265/90000\r\n",
      ),
    ).rejects.toThrow("cannot decode");
    expect(
      screen.pc.setLocalDescription,
    ).not.toHaveBeenCalled();
    expect(screen.pc.close).toHaveBeenCalledOnce();
  },
);

it.each(["H264", "H265"])(
  "accepts negotiated %s video without changing the browser codec choice",
  async (codec) => {
    const screen = new ScreenReceiver({}, vi.fn(), vi.fn());
    const sdp = `v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 104\r\na=recvonly\r\na=rtpmap:104 ${codec}/90000\r\n`;
    Object.assign(screen.pc, {
      iceGatheringState: "complete",
      localDescription: { sdp },
      setRemoteDescription: vi.fn(async () => {}),
      createAnswer: vi.fn(async () => ({
        type: "answer",
        sdp,
      })),
      setLocalDescription: vi.fn(async () => {}),
    });
    expect(await screen.answer(sdp)).toBe(sdp);
    screen.close();
  },
);
