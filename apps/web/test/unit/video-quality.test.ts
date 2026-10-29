import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  VideoQualityPeer,
  resolveVideoQuality,
  type VideoQualitySource,
} from "@/libs/domain/video-quality";
import { applyBrowserVideoQuality } from "@/libs/domain/browser-video-quality";
import {
  DisplayFrameRateCalibration,
  estimateDisplayFrameRate,
} from "@/libs/domain/display-frame-rate";

const limits = {
  maxWidth: 2560,
  maxHeight: 1440,
  frameRate: 165,
  maxBitrate: 20_000_000,
};
const source: VideoQualitySource = {
  id: "native:screen",
  locator: "native:screen",
  transport: "peer-1",
  limits,
};
class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  messages: any[] = [];
  send(data: string) {
    this.messages.push(JSON.parse(data));
  }
  receive(data: unknown) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(data),
      }),
    );
  }
}
const peers: VideoQualityPeer[] = [];
function fixture(sources: VideoQualitySource[] = []) {
  const channel = new Channel();
  const apply = vi.fn(
    async (s: VideoQualitySource, preference) =>
      resolveVideoQuality(s.limits, preference),
  );
  const peer = new VideoQualityPeer({
    sources: () => sources,
    apply,
  });
  peers.push(peer);
  peer.bind(channel as unknown as RTCDataChannel);
  return { peer, channel, apply, sources };
}
const advertise = (channel: Channel, sources = [source]) =>
  channel.receive({ type: "quality-sources", sources });
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const p of peers.splice(0)) p.dispose();
  vi.useRealTimers();
});

describe("per-viewer quality", () => {
  it("applies common defaults to existing and future videos, retaining publisher ceilings and restoring automatic FPS", async () => {
    const { peer, channel } = fixture();
    peer.setRefreshRate(144);
    advertise(channel);
    const second = {
      ...source,
      id: "native:second",
      locator: "native:second",
      limits: { ...limits, frameRate: 60 },
    };
    const preference = {
      height: 720,
      fps: 120,
      bitrate: 4_000_000,
    };
    peer.setPreference(preference);
    advertise(channel, [source, second]);
    await vi.advanceTimersByTimeAsync(150);
    const requests = channel.messages.filter(
      (m) => m.type === "quality-request",
    );
    expect(requests).toHaveLength(2);
    for (const request of requests)
      expect(request.preference).toEqual(preference);
    expect(peer.receivers()).toHaveLength(2);
    expect(
      resolveVideoQuality(
        second.limits,
        requests[1].preference,
      ).frameRate,
    ).toBe(60);
    const count = channel.messages.length;
    peer.setPreference({ ...preference });
    await vi.advanceTimersByTimeAsync(150);
    expect(channel.messages).toHaveLength(count);
    peer.disconnect();
    peer.setPreference({});
    const replacement = new Channel();
    peer.bind(replacement as unknown as RTCDataChannel);
    advertise(replacement, [source, second]);
    await vi.advanceTimersByTimeAsync(150);
    const resetRequests = replacement.messages.filter(
      (m) => m.type === "quality-request",
    );
    expect(resetRequests).toHaveLength(2);
    for (const request of resetRequests)
      expect(request.preference).toEqual({
        refreshRate: 144,
      });
    const visible = vi.fn(() => peer.receivers());
    peer.addEventListener("change", visible);
    peer.dispose();
    expect(visible.mock.results.at(-1)?.value).toEqual([]);
  });
  it("upgrades the actual automatic quality request from 60 to 120 with mixed callback intervals", async () => {
    const { peer, channel } = fixture();
    const calibration = new DisplayFrameRateCalibration();
    let now = 0;
    const sample = (intervals: number[]) => {
      now += intervals.reduce(
        (sum, interval) => sum + interval,
        0,
      );
      const fps = calibration.sample(
        intervals,
        now,
        "display",
      );
      if (fps) peer.setRefreshRate(fps);
    };
    for (let n = 0; n < 4; n++)
      sample(Array(120).fill(1000 / 60));
    advertise(channel);
    await vi.advanceTimersByTimeAsync(150);
    expect(
      channel.messages.at(-1).preference.refreshRate,
    ).toBe(60);
    for (let n = 0; n < 4; n++) {
      sample(
        Array.from(
          { length: 120 },
          (_, i) => 1000 / (i % 4 === 0 ? 120 : 60),
        ),
      );
      sample(Array(120).fill(1000 / 60));
    }
    await vi.advanceTimersByTimeAsync(150);
    const request = channel.messages.at(-1);
    expect(request.preference.refreshRate).toBe(120);
    channel.receive({
      type: "quality-result",
      id: source.id,
      revision: request.revision,
      applied: resolveVideoQuality(
        source.limits,
        request.preference,
      ),
    });
    expect(
      peer.get(source.locator)?.applied?.frameRate,
    ).toBe(120);
    const count = channel.messages.length;
    for (let n = 0; n < 30; n++)
      sample(Array(120).fill(1000 / 60));
    await vi.advanceTimersByTimeAsync(150);
    expect(channel.messages).toHaveLength(count);
  });
  it("caps 165 FPS to a 120 Hz viewer without changing publisher limits", () => {
    expect(
      resolveVideoQuality(limits, { refreshRate: 120 }),
    ).toEqual({ ...limits, frameRate: 120 });
    expect(
      resolveVideoQuality(limits, {
        height: 1080,
        fps: 240,
        bitrate: 99_000_000,
      }),
    ).toEqual({
      ...limits,
      maxWidth: 1920,
      maxHeight: 1080,
    });
    expect(
      resolveVideoQuality(limits, {
        fps: 144,
        refreshRate: 60,
      }).frameRate,
    ).toBe(144);
    expect(limits.frameRate).toBe(165);
    expect(
      resolveVideoQuality(
        { ...limits, maxWidth: 1920, maxHeight: 1200 },
        { height: 720 },
      ),
    ).toMatchObject({ maxWidth: 1152, maxHeight: 720 });
  });
  it("coalesces edits and ignores stale replies while preserving last applied quality on failure", async () => {
    const { peer, channel } = fixture();
    advertise(channel);
    const c = peer.get(source.locator)!;
    c.set({ fps: 60 });
    c.set({ fps: 120 });
    await vi.advanceTimersByTimeAsync(150);
    const requests = channel.messages.filter(
      (m) => m.type === "quality-request",
    );
    expect(requests).toHaveLength(1);
    expect(requests[0].preference.fps).toBe(120);
    channel.receive({
      type: "quality-result",
      id: source.id,
      revision: c.revision - 1,
      applied: limits,
    });
    expect(c.pending).toBe(true);
    const applied = { ...limits, frameRate: 120 };
    channel.receive({
      type: "quality-result",
      id: source.id,
      revision: c.revision,
      applied,
    });
    c.set({ height: 720 });
    channel.receive({
      type: "quality-result",
      id: source.id,
      revision: c.revision,
    });
    expect(c.error).toBe(true);
    expect(c.applied).toEqual(applied);
    expect(c.pending).toBe(false);
  });
  it("preserves preferences across media reconnect and clears them when the source stops", () => {
    const { peer, channel } = fixture();
    advertise(channel);
    const c = peer.get(source.locator)!;
    c.set({ height: 720, fps: 60 });
    peer.disconnect();
    expect(c.available).toBe(false);
    const replacement = new Channel();
    peer.bind(replacement as unknown as RTCDataChannel);
    advertise(replacement, [
      { ...source, transport: "peer-2" },
    ]);
    expect(peer.get(source.locator)).toBe(c);
    expect(c.preference).toEqual({ height: 720, fps: 60 });
    expect(c.available).toBe(true);
    advertise(replacement, []);
    expect(peer.get(source.locator)).toBeUndefined();
    advertise(replacement);
    expect(peer.get(source.locator)?.preference).toEqual(
      {},
    );
  });
  it("applies only to this peer's advertised transport and rejects removed or malformed sources", async () => {
    const a = fixture([source]);
    const b = fixture([source]);
    const request = {
      type: "quality-request",
      id: source.id,
      transport: source.transport,
      revision: 1,
      preference: { fps: 60 },
    };
    a.channel.receive(request);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.apply).toHaveBeenCalledOnce();
    expect(b.apply).not.toHaveBeenCalled();
    a.channel.receive({
      ...request,
      revision: 2,
      transport: "foreign",
    });
    a.channel.receive({
      ...request,
      revision: 3,
      preference: { fps: -1 },
    });
    a.channel.receive({ ...request, revision: 4 });
    a.sources.splice(0);
    await vi.advanceTimersByTimeAsync(0);
    expect(a.apply).toHaveBeenCalledOnce();
  });
  it("does not expose controls for old peers, times out unanswered requests, and cleans timers", async () => {
    const { peer, channel } = fixture();
    expect(peer.get(source.locator)).toBeUndefined();
    advertise(channel);
    const c = peer.get(source.locator)!;
    await vi.advanceTimersByTimeAsync(10150);
    expect(c.pending).toBe(false);
    expect(c.error).toBe(true);
    peer.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("reapplies sender preferences when publisher bounds change", async () => {
    const f = fixture([{ ...source }]);
    f.channel.receive({
      type: "quality-request",
      id: source.id,
      transport: source.transport,
      revision: 1,
      preference: { fps: 120 },
    });
    await vi.advanceTimersByTimeAsync(0);
    f.sources[0] = {
      ...source,
      limits: { ...limits, frameRate: 60 },
    };
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.apply).toHaveBeenCalledTimes(2);
    expect(
      f.channel.messages.at(-1).sources[0].limits.frameRate,
    ).toBe(60);
  });
});

describe("browser sender parameters", () => {
  function sender() {
    let parameters: RTCRtpSendParameters = {
      encodings: [{}],
    } as RTCRtpSendParameters;
    const track = {
      readyState: "live",
      getSettings: () => ({
        width: 2560,
        height: 1440,
        frameRate: 165,
      }),
      applyConstraints: vi.fn(),
    };
    const s = {
      track,
      getParameters: () => structuredClone(parameters),
      setParameters: vi.fn(
        async (next: RTCRtpSendParameters) => {
          parameters = next;
        },
      ),
    };
    return {
      s: s as unknown as RTCRtpSender,
      track,
      mock: s,
    };
  }
  it("changes only one sender and keeps shared capture constraints intact", async () => {
    const a = sender();
    const b = sender();
    expect(
      await applyBrowserVideoQuality(a.s, source, {
        height: 720,
        fps: 60,
      }),
    ).toMatchObject({
      maxWidth: 1280,
      maxHeight: 720,
      frameRate: 60,
    });
    expect(a.s.getParameters().encodings[0]).toMatchObject({
      scaleResolutionDownBy: 2,
      maxFramerate: 60,
    });
    expect(b.mock.setParameters).not.toHaveBeenCalled();
    expect(a.track.applyConstraints).not.toHaveBeenCalled();
  });
  it("rolls back when a browser silently ignores a parameter", async () => {
    const a = sender();
    a.mock.setParameters.mockImplementationOnce(
      async () => {},
    );
    await expect(
      applyBrowserVideoQuality(a.s, source, {
        height: 720,
      }),
    ).rejects.toThrow("did not accept");
    expect(a.mock.setParameters).toHaveBeenCalledTimes(2);
    expect(a.track.applyConstraints).not.toHaveBeenCalled();
  });
});

it("estimates stable display cadence without interpreting background gaps or jitter as a lower refresh rate", () => {
  expect(
    estimateDisplayFrameRate(Array(120).fill(1000 / 120)),
  ).toBe(120);
  expect(
    estimateDisplayFrameRate(Array(120).fill(1000 / 165)),
  ).toBe(165);
  expect(
    estimateDisplayFrameRate(Array(120).fill(1000)),
  ).toBeUndefined();
  expect(
    estimateDisplayFrameRate(
      Array.from(
        { length: 120 },
        (_, n) => [7, 13, 19][n % 3],
      ),
    ),
  ).toBeUndefined();
});
