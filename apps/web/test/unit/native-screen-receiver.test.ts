import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { ScreenReceiver } from "@/libs/domain/native-screen/receiver";

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
  close = vi.fn();
}
beforeEach(() => {
  vi.stubGlobal("RTCPeerConnection", Connection);
  vi.stubGlobal("MediaStream", Stream);
});
afterEach(() => vi.unstubAllGlobals());
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
