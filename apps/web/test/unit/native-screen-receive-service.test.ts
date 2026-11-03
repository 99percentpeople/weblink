import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { MediaReceiveService } from "@/libs/application/media-receive-service";
import { ScreenReceiver } from "@/libs/domain/native-screen/receiver";
import {
  ScreenDecodeError,
  ScreenDecodeStallError,
} from "@/libs/domain/native-screen/errors";
import type {
  NativeReceiveConnection,
  NativeReceiveEvent,
  NativeMediaReceive,
} from "@weblink/platform";
import type {
  ControlDataChannel,
  RemotePointer,
} from "@/libs/domain/remote-control/pointer";

vi.mock("@/libs/domain/native-screen/receiver", () => ({
  ScreenReceiver: class BrowserReceiver {
    close() {}
  },
}));
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
beforeEach(() => {
  vi.stubGlobal("MediaStream", Stream);
  vi.stubGlobal("RTCRtpReceiver", {
    getCapabilities: (kind: string) => ({
      codecs: [
        {
          mimeType:
            kind === "video" ? "video/h264" : "audio/opus",
        },
      ],
    }),
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const offer = (codec = "H265") =>
  `v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 100\r\na=rtpmap:100 ${codec}/90000\r\n`;
function fixture(
  codecs = ["video/h265", "video/h264"],
  allowBrowserFallback = true,
) {
  let emit!: (event: NativeReceiveEvent) => void;
  const track = {
    kind: "video",
    stop: vi.fn(),
  } as unknown as MediaStreamTrack;
  const connection: NativeReceiveConnection = {
    stream: new MediaStream([track]),
    answer: vi.fn(async () => "answer"),
    addIceCandidate: vi.fn(async () => {}),
    stats: vi.fn(async () => []),
    send: vi.fn(async () => {}),
    close: vi.fn(),
  };
  const native: NativeMediaReceive = {
    allowBrowserFallback,
    codecs: vi.fn(async () => codecs),
    open: vi.fn(async (_config, event) => {
      emit = event;
      return connection;
    }),
  };
  const service = new MediaReceiveService(native);
  const changed = vi.fn();
  const failed = vi.fn();
  const candidate = vi.fn();
  const create = (codec = "H265") =>
    service.createScreenReceiver(
      offer(codec),
      {},
      changed,
      failed,
      candidate,
    );
  return {
    service,
    native,
    connection,
    create,
    changed,
    failed,
    candidate,
    emit: (event: NativeReceiveEvent) => emit(event),
    track,
  };
}
it("advertises native formats only after discovery and retains browser audio capabilities", async () => {
  const f = fixture();
  expect(f.service.capabilities()).toEqual({
    video: ["video/h264"],
    audio: ["audio/opus"],
  });
  await f.service.ready;
  expect(f.service.capabilities().video).toEqual([
    "video/h264",
    "video/h265",
  ]);
});

it("advertises only native video formats when browser fallback is disabled", async () => {
  const f = fixture(["video/h265"], false);
  expect(f.service.capabilities().video).toEqual([]);
  await f.service.ready;
  expect(f.service.capabilities()).toEqual({
    video: ["video/h265"],
    audio: ["audio/opus"],
  });
  expect(() => f.create("H264")).toThrow(ScreenDecodeError);
});

it("reserves the screen slot independently of camera receivers and advertises native audio separately", async () => {
  const f = fixture(["video/h265", "audio/opus"], false);
  await f.service.ready;
  expect(f.service.cameraCapabilities()).toEqual({
    video: ["video/h265"],
    audio: ["audio/opus"],
  });
  expect(f.service.capabilities().video).toEqual([
    "video/h265",
  ]);
  const screen = f.create();
  const camera = f.service.createCameraReceiver(
    offer(),
    {},
    vi.fn(),
    vi.fn(),
    vi.fn(),
  );
  expect(
    vi
      .mocked(f.native.open)
      .mock.calls.map((args) => args[3]),
  ).toEqual(["screen", "camera"]);
  camera.close();
  expect(() => f.create()).toThrow("already in use");
  screen.close();
});

it("does not route unsupported, busy or legacy native-only sessions to the browser", async () => {
  const unavailable = fixture([], false);
  await unavailable.service.ready;
  expect(() => unavailable.create()).toThrow(
    ScreenDecodeError,
  );
  const f = fixture(undefined, false);
  await f.service.ready;
  const receiver = f.create();
  expect(() => f.create("H264")).toThrow("already in use");
  receiver.close();
  expect(() =>
    f.service.createScreenReceiver(
      offer(),
      {},
      f.changed,
      f.failed,
    ),
  ).toThrow("trickle ICE");
});

it("selects another native codec after failure without opening a browser receiver", async () => {
  const f = fixture(undefined, false);
  await f.service.ready;
  const receiver = f.create();
  await receiver.answer(offer());
  f.emit({ type: "error", error: "native decoder failed" });
  expect(f.failed).toHaveBeenCalledExactlyOnceWith(
    expect.any(ScreenDecodeError),
  );
  expect(f.service.capabilities().video).toEqual([
    "video/h264",
  ]);
  expect(() => f.create()).toThrow(ScreenDecodeError);
  const replacement = f.create("H264");
  expect(replacement).not.toBeInstanceOf(ScreenReceiver);
  await replacement.answer(offer("H264"));
  expect(f.native.open).toHaveBeenCalledTimes(2);
  replacement.close();
});

it("restarts an overloaded native-only receiver without blacklisting its codec", async () => {
  vi.useFakeTimers();
  const f = fixture(undefined, false);
  await f.service.ready;
  const receiver = f.create();
  await receiver.answer(offer());
  f.emit({ type: "state", state: "connected" });
  let reads = 0;
  vi.mocked(f.connection.stats).mockImplementation(
    async () => {
      reads++;
      return [
        {
          id: "video",
          type: "inbound-rtp",
          timestamp: reads * 1000,
          kind: "video",
          framesDecoded: reads * 40,
          bytesReceived: reads * 100000,
          totalProcessingDelay: reads * 40 * 0.4,
        },
      ];
    },
  );
  receiver.monitorDecode(vi.fn());
  await vi.advanceTimersByTimeAsync(4000);
  expect(f.failed).toHaveBeenCalledExactlyOnceWith(
    expect.any(ScreenDecodeStallError),
  );
  expect(f.service.capabilities().video).toContain(
    "video/h265",
  );
  const replacement = f.create();
  expect(replacement).not.toBeInstanceOf(ScreenReceiver);
  await replacement.answer(offer());
  replacement.close();
  expect(vi.getTimerCount()).toBe(0);
});
it("queues candidates until the remote description and presents the selected native track", async () => {
  const f = fixture();
  await f.service.ready;
  const receiver = f.create();
  const candidate = {
    candidate: "candidate:1",
    sdpMid: "0",
  };
  await receiver.addIceCandidate(candidate);
  expect(
    f.connection.addIceCandidate,
  ).not.toHaveBeenCalled();
  await receiver.answer(offer());
  expect(f.connection.addIceCandidate).toHaveBeenCalledWith(
    candidate,
  );
  f.emit({ type: "track" });
  expect(
    f.changed.mock.lastCall?.[0].getVideoTracks(),
  ).toEqual([f.track]);
  f.emit({ type: "candidate", candidate });
  expect(f.candidate).toHaveBeenCalledWith(candidate);
  f.emit({ type: "state", state: "connected" });
  await receiver.connected();
  receiver.close();
  expect(f.connection.close).toHaveBeenCalledTimes(1);
});
it("keeps the second view and legacy non-trickle offers on the browser path", async () => {
  const f = fixture();
  await f.service.ready;
  const first = f.create();
  expect(f.create("H264")).toBeInstanceOf(ScreenReceiver);
  first.close();
  expect(
    f.service.createScreenReceiver(
      offer(),
      {},
      f.changed,
      f.failed,
    ),
  ).toBeInstanceOf(ScreenReceiver);
});
it("rejects failed HEVC and returns the replacement H264 offer to the browser", async () => {
  const f = fixture();
  await f.service.ready;
  vi.mocked(f.connection.answer).mockRejectedValue(
    new Error("MF decode unavailable"),
  );
  const receiver = f.create();
  await expect(
    receiver.answer(offer()),
  ).rejects.toBeInstanceOf(ScreenDecodeError);
  expect(f.connection.close).toHaveBeenCalled();
  expect(f.service.capabilities().video).toEqual([
    "video/h264",
  ]);
  expect(f.create("H264")).toBeInstanceOf(ScreenReceiver);
});
it("retries a browser-supported format through the browser after native decode failure", async () => {
  const f = fixture();
  await f.service.ready;
  const receiver = f.create("H264");
  await receiver.answer(offer("H264"));
  receiver.decodeFailed();
  expect(f.failed).toHaveBeenCalledWith(
    expect.any(ScreenDecodeStallError),
  );
  expect(f.create("H264")).toBeInstanceOf(ScreenReceiver);
  receiver.close();
  expect(f.connection.close).toHaveBeenCalledTimes(1);
});

it("releases overloaded native HEVC and advertises browser fallback capabilities", async () => {
  vi.useFakeTimers();
  const f = fixture();
  await f.service.ready;
  const receiver = f.create();
  await receiver.answer(offer());
  f.emit({ type: "state", state: "connected" });
  let reads = 0;
  vi.mocked(f.connection.stats).mockImplementation(
    async () => {
      reads++;
      return [
        {
          id: "video",
          type: "inbound-rtp",
          timestamp: reads * 1000,
          kind: "video",
          framesDecoded: reads * 40,
          bytesReceived: reads * 100000,
          totalProcessingDelay: reads * 40 * 0.4,
        },
      ];
    },
  );
  receiver.monitorDecode(vi.fn());
  await vi.advanceTimersByTimeAsync(4000);
  expect(f.failed).toHaveBeenCalledExactlyOnceWith(
    expect.any(ScreenDecodeError),
  );
  expect(f.connection.close).toHaveBeenCalledOnce();
  expect(f.service.capabilities().video).toEqual([
    "video/h264",
  ]);
  expect(f.create("H264")).toBeInstanceOf(ScreenReceiver);
  expect(vi.getTimerCount()).toBe(0);
});
it("closes a late native open without reporting a cancelled startup as a codec failure", async () => {
  const f = fixture();
  await f.service.ready;
  let resolve!: (c: NativeReceiveConnection) => void;
  vi.mocked(f.native.open).mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const receiver = f.create();
  const answer = receiver.answer(offer());
  receiver.close();
  resolve(f.connection);
  await expect(answer).rejects.toThrow("Receiver closed");
  expect(f.connection.close).toHaveBeenCalledTimes(1);
  expect(f.failed).not.toHaveBeenCalled();
  expect(f.service.capabilities().video).toContain(
    "video/h265",
  );
});
it("exposes native receive diagnostics using the same statistics model", async () => {
  const f = fixture();
  await f.service.ready;
  const receiver = f.create();
  await receiver.answer(offer());
  vi.mocked(f.connection.stats).mockResolvedValue([
    {
      id: "codec",
      type: "codec",
      timestamp: 10,
      mimeType: "video/H265",
    },
    {
      id: "video",
      type: "inbound-rtp",
      timestamp: 10,
      kind: "video",
      codecId: "codec",
      framesDecoded: 5,
      totalDecodeTime: 0.01,
      decoderImplementation: "Windows MF / D3D11",
      powerEfficientDecoder: true,
    },
  ]);
  expect(
    (await receiver.getVideoStats(f.track))[0],
  ).toMatchObject({
    frames: 5,
    decodeSeconds: 0.01,
    codec: "video/H265",
    powerEfficientDecoder: true,
  });
  receiver.close();
});
it("preserves control send order across asynchronous native IPC and drops queued sends on close", async () => {
  const f = fixture();
  await f.service.ready;
  let channel!: ControlDataChannel;
  let release!: () => void;
  const control = Object.assign(new EventTarget(), {
    bind: (value: ControlDataChannel) => {
      channel = value;
    },
    close: () => channel?.close(),
  });
  const receiver = f.service.createScreenReceiver(
    offer(),
    {},
    f.changed,
    f.failed,
    f.candidate,
    control as unknown as RemotePointer,
  );
  await receiver.answer(offer());
  f.emit({
    type: "channel",
    label: "weblink-control",
    state: "open",
  });
  vi.mocked(f.connection.send).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  channel.send("first");
  channel.send("second");
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(f.connection.send).toHaveBeenCalledExactlyOnceWith(
    "weblink-control",
    "first",
  );
  receiver.close();
  release();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(f.connection.send).toHaveBeenCalledOnce();
  expect(channel.bufferedAmount).toBe(0);
});
