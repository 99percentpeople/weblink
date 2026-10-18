import { afterEach, expect, it, vi } from "vitest";
import { RECORDING_AUDIO_CODECS } from "@weblink/platform";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { subscribeNativeRecording } from "../src/recording";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(
    (done) => (resolve = done),
  );
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function packet(kind: number, segment = 1, codec = 2) {
  const data = new ArrayBuffer(40);
  const view = new DataView(data);
  view.setUint32(0, 4, true);
  view.setUint32(4, segment, true);
  view.setBigInt64(8, 1234567n, true);
  view.setUint32(16, 640, true);
  view.setUint32(20, 360, true);
  view.setUint32(24, 48000, true);
  view.setUint32(28, 2, true);
  view.setUint8(32, kind);
  view.setUint8(33, codec);
  view.setUint8(34, 1);
  return data;
}
function fixture(encodedAudio = false) {
  const reads: ReturnType<typeof deferred<ArrayBuffer>>[] =
    [];
  const ipc = vi.fn((command: string) => {
    if (command === "capture_recording_open")
      return {
        audio: encodedAudio
          ? null
          : { sampleRate: 48000, channelCount: 2 },
        encodedAudio,
      };
    if (command === "capture_recording_read") {
      const read = deferred<ArrayBuffer>();
      reads.push(read);
      return read.promise;
    }
  });
  mockIPC(ipc);
  return { ipc, reads };
}
afterEach(clearMocks);
it("delivers native HEVC and PCM on one clock with only one binary read in flight", async () => {
  const f = fixture();
  const frame = vi.fn(),
    audio = vi.fn(),
    ended = vi.fn();
  const subscription = (await subscribeNativeRecording(
    "source",
    { frame, audio, ended },
  ))!;
  expect(subscription.audioFormat).toEqual({
    sampleRate: 48000,
    channelCount: 2,
  });
  subscription.resume();
  await flush();
  expect(f.reads).toHaveLength(1);
  const batch = new Uint8Array(80);
  batch.set(new Uint8Array(packet(0)));
  batch.set(new Uint8Array(packet(1)), 40);
  f.reads[0].resolve(batch.buffer);
  await flush();
  expect(frame).toHaveBeenCalledWith(
    expect.objectContaining({
      mimeType: "video/h265",
      timestamp: 1234567,
      timestampScale: 1000000,
      segment: 1,
    }),
  );
  expect(audio).toHaveBeenCalledWith(
    expect.objectContaining({
      timestamp: 1234567,
      sampleRate: 48000,
      channelCount: 2,
    }),
  );
  expect(f.reads).toHaveLength(2);
  const stop = subscription.stop();
  f.reads[1].resolve(new ArrayBuffer(0));
  await stop;
  expect(ended).not.toHaveBeenCalled();
  expect(
    f.ipc.mock.calls.filter(
      ([command]) => command === "capture_recording_close",
    ),
  ).toHaveLength(1);
  expect(
    f.ipc.mock.calls.some(
      ([command]) =>
        command === "capture_offer" ||
        command === "capture_close_peer",
    ),
  ).toBe(false);
});
it.each(RECORDING_AUDIO_CODECS)(
  "copies sender $codec with the video clock, isolates pause and drains the final packet",
  async (format) => {
    const sound = (segment = 1) => {
      const data = packet(3, segment, format.id);
      const view = new DataView(data);
      view.setUint32(24, format.sampleRate, true);
      view.setUint32(28, format.channels, true);
      return data;
    };
    const f = fixture(true);
    const frame = vi.fn(),
      encodedAudio = vi.fn(),
      audio = vi.fn(),
      ended = vi.fn();
    const subscription = (await subscribeNativeRecording(
      "source",
      { frame, encodedAudio, audio, ended },
    ))!;
    expect(subscription.encodedAudio).toBe(true);
    expect(subscription.audioFormat).toBeUndefined();
    subscription.resume();
    await flush();
    const batch = new Uint8Array(80);
    batch.set(new Uint8Array(packet(0)));
    batch.set(new Uint8Array(sound()), 40);
    f.reads[0].resolve(batch.buffer);
    await flush();
    expect(frame).toHaveBeenCalledWith(
      expect.objectContaining({ clockTime: 1234.567 }),
    );
    expect(encodedAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        clockTime: 1234.567,
        timestamp: 640,
        ssrc: 360,
        mimeType: format.mimeType,
        sampleRate: format.sampleRate,
        clockRate: format.clockRate,
        channelCount: format.channels,
        segment: 1,
      }),
    );
    subscription.pause();
    await flush();
    f.reads[1].resolve(sound());
    await flush();
    expect(encodedAudio).toHaveBeenCalledOnce();
    subscription.resume();
    await flush();
    const stopping = subscription.stop();
    expect(subscription.stop()).toBe(stopping);
    f.reads[2].resolve(sound(2));
    await stopping;
    expect(encodedAudio).toHaveBeenCalledTimes(2);
    expect(audio).not.toHaveBeenCalled();
    expect(ended).not.toHaveBeenCalled();
    expect(f.ipc.mock.calls.at(-1)?.[0]).toBe(
      "capture_recording_close",
    );
  },
);
it("can explicitly reopen PCM after an encoded preparation failure", async () => {
  const f = fixture();
  const subscription = (await subscribeNativeRecording(
    "source",
    { frame() {}, ended() {} },
    undefined,
    { encodedAudio: false },
  ))!;
  expect(f.ipc).toHaveBeenCalledWith(
    "capture_recording_open",
    expect.objectContaining({ encodedAudio: false }),
  );
  expect(subscription.encodedAudio).toBe(false);
  expect(subscription.audioFormat?.sampleRate).toBe(48000);
  const stopping = subscription.stop();
  f.reads[0]?.resolve(new ArrayBuffer(0));
  await stopping;
});
it("ignores stale pause/resume segments and drains an accepted callback before closing", async () => {
  const f = fixture();
  const written = deferred<void>();
  const frame = vi.fn(() => written.promise);
  const subscription = (await subscribeNativeRecording(
    "source",
    { frame, ended: vi.fn() },
  ))!;
  subscription.resume();
  subscription.pause();
  subscription.resume();
  await flush();
  f.reads[0].resolve(packet(0, 1));
  await flush();
  expect(frame).not.toHaveBeenCalled();
  f.reads[1].resolve(packet(0, 2, 1));
  await flush();
  expect(frame).toHaveBeenCalledOnce();
  const stopping = subscription.stop();
  await flush();
  expect(
    f.ipc.mock.calls.some(
      ([command]) => command === "capture_recording_close",
    ),
  ).toBe(false);
  written.resolve();
  await stopping;
  expect(f.ipc.mock.calls.at(-1)?.[0]).toBe(
    "capture_recording_close",
  );
});
it("closes a late native subscription after cancellation without reading media", async () => {
  const opening = deferred<object>();
  const ipc = vi.fn((command: string) =>
    command === "capture_recording_open"
      ? opening.promise
      : undefined,
  );
  mockIPC(ipc);
  const controller = new AbortController();
  const result = subscribeNativeRecording(
    "source",
    { frame() {}, ended() {} },
    controller.signal,
  );
  const rejected = expect(result).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await flush();
  opening.resolve({ audio: null });
  await rejected;
  expect(ipc.mock.calls.at(-1)?.[0]).toBe(
    "capture_recording_close",
  );
  expect(
    ipc.mock.calls.some(
      ([command]) => command === "capture_recording_read",
    ),
  ).toBe(false);
});
it("reports malformed packets and releases only its recording subscription", async () => {
  const f = fixture();
  const ended = vi.fn();
  const subscription = (await subscribeNativeRecording(
    "source",
    { frame() {}, ended },
  ))!;
  subscription.resume();
  await flush();
  f.reads[0].resolve(new ArrayBuffer(1));
  await flush();
  expect(ended.mock.calls[0]?.[0].message).toContain(
    "Truncated",
  );
  await subscription.stop();
});
