import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createScreenSharing } from "@/libs/application/screen-sharing";
import { AutomationScreenShares } from "@/libs/application/automation/screen-sharing";
import { createLocalStreamService } from "@/libs/application/local-stream-service";
import {
  getMeetingAudioSource,
  getMeetingVideoSourceKind,
} from "@/libs/application/meeting-media-service";

const captures = vi.hoisted(
  () => new WeakMap<object, object>(),
);
vi.mock("@/libs/application/native-screen-service", () => ({
  getNativeCaptureStatus: (track: object) =>
    captures.get(track),
  getNativeScreenPublication: (track: object) => {
    const capture = captures.get(track) as
      | { source?: { id: string } }
      | undefined;
    return capture && { sourceId: capture.source?.id };
  },
}));
let next = 0;
class Track extends EventTarget {
  id = `track-${++next}`;
  readyState = "live";
  contentHint = "";
  enabled = true;
  stop = vi.fn(() => {
    this.readyState = "ended";
    this.dispatchEvent(new Event("ended"));
  });
  constructor(readonly kind: string) {
    super();
  }
  getSettings = () => ({});
}
class Stream extends EventTarget {
  constructor(private tracks: MediaStreamTrack[] = []) {
    super();
  }
  getTracks = () => [...this.tracks];
  getVideoTracks = () =>
    this.tracks.filter((t) => t.kind === "video");
  getAudioTracks = () =>
    this.tracks.filter((t) => t.kind === "audio");
  removeTrack = (track: MediaStreamTrack) => {
    this.tracks = this.tracks.filter((t) => t !== track);
  };
}
beforeEach(() => vi.stubGlobal("MediaStream", Stream));
afterEach(() => vi.unstubAllGlobals());
function screen(sourceId = "monitor") {
  const video = new Track("video"),
    audio = new Track("audio");
  const capture = {
    sessionId: video.id,
    state: "running",
    source: { id: sourceId },
  };
  captures.set(video, capture);
  captures.set(audio, capture);
  return new MediaStream([
    video,
    audio,
  ] as unknown as MediaStreamTrack[]);
}
function setup() {
  const local = createLocalStreamService();
  return {
    local,
    share: createScreenSharing({
      stream: local.stream,
      publish: local.replace,
    }),
  };
}
const signal = () => new AbortController().signal;

it("cancels a published automation start but preserves explicit user retention", async () => {
  const { local, share } = setup();
  const automation = new AutomationScreenShares(share);
  const cancelled = new AbortController();
  const first = screen();
  await automation.start(
    "a",
    "monitor",
    cancelled.signal,
    async () => first,
    async () => {},
  );
  cancelled.abort();
  expect(
    first
      .getTracks()
      .every((t) => t.readyState === "ended"),
  ).toBe(true);
  const retained = screen();
  await automation.start(
    "b",
    "monitor",
    signal(),
    async () => retained,
    async () => {},
  );
  share.retain(retained.getVideoTracks()[0]);
  automation.release("b");
  expect(local.stream()?.getTracks()).toEqual(
    retained.getTracks(),
  );
  local.dispose();
});

it("releases only the caller's automation share and preserves a manual publication", async () => {
  const { local, share } = setup();
  const automation = new AutomationScreenShares(share);
  const stream = screen();
  local.replace(stream);
  const start = (id: string) =>
    automation.start(
      id,
      "monitor",
      signal(),
      async () => screen(),
      async () => {},
    );
  const a = await start("permission-a");
  const b = await start("permission-b");
  expect(a.trackId).toBe(b.trackId);
  expect(() =>
    automation.stop(["foreign"], a.trackId),
  ).toThrow("PERMISSION_DENIED");
  expect(
    automation.stop(["permission-a"], a.trackId),
  ).toEqual({
    stopped: false,
    released: true,
    retained: true,
  });
  automation.release("permission-b");
  expect(local.stream()?.getTracks()).toEqual(
    stream.getTracks(),
  );
  local.dispose();
});

it("closes an automation-created picture and audio only after its final owner exits", async () => {
  const { local, share } = setup();
  const automation = new AutomationScreenShares(share);
  const stream = screen();
  const start = (id: string) =>
    automation.start(
      id,
      "monitor",
      signal(),
      async () => stream,
      async () => {},
    );
  const first = await start("a");
  await start("a");
  await start("b");
  automation.release("a");
  expect(local.stream()?.getVideoTracks()[0].id).toBe(
    first.trackId,
  );
  expect(automation.stop(["b"], first.trackId)).toEqual({
    stopped: true,
    released: true,
    retained: false,
  });
  expect(local.stream()).toBeNull();
  for (const track of stream.getTracks())
    expect(track.stop).toHaveBeenCalledOnce();
});

it("keeps a handed-off temporary screen alive until the new native controller exits", async () => {
  const local = createLocalStreamService();
  let controlled: string | undefined;
  const share = createScreenSharing({
    stream: local.stream,
    publish: (stream) => {
      local.replace(stream);
      share.synchronize();
    },
    controlledSource: () => controlled,
  });
  const automation = new AutomationScreenShares(share);
  const temporary = await automation.start(
    "a",
    "monitor",
    signal(),
    async () => screen(),
    async () => {},
  );
  expect(local.stream()).not.toBeNull();
  automation.acquired(
    "a",
    temporary.trackId,
    "automation-lease",
  );
  controlled = "monitor";
  // Manual handoff has committed before the old automation observes its lease end.
  automation.synchronize(["a"], null);
  expect(local.stream()).not.toBeNull();
  controlled = undefined;
  share.synchronize();
  expect(local.stream()).toBeNull();
});

it("releases the old automation monitor on a fresh lease, then cleans up on revocation", async () => {
  const { local, share } = setup();
  const automation = new AutomationScreenShares(share);
  const start = (source: string) =>
    automation.start(
      "a",
      source,
      signal(),
      async () => screen(source),
      async () => {},
    );
  const a = await start("monitor-a");
  automation.acquired("a", a.trackId, "lease-a");
  const b = await start("monitor-b");
  automation.acquired("a", b.trackId, "lease-b");
  expect(
    local
      .stream()
      ?.getVideoTracks()
      .map((t) => t.id),
  ).toEqual([b.trackId]);
  automation.synchronize(["a"], "lease-b");
  expect(local.stream()).not.toBeNull();
  automation.synchronize([], null);
  expect(local.stream()).toBeNull();
});

it("cleans up failed acquisition without releasing an already active share", async () => {
  const { local, share } = setup();
  const automation = new AutomationScreenShares(share);
  const a = await automation.start(
    "a",
    "a",
    signal(),
    async () => screen("a"),
    async () => {},
  );
  automation.acquired("a", a.trackId, "lease-a");
  const b = await automation.start(
    "a",
    "b",
    signal(),
    async () => screen("b"),
    async () => {},
  );
  automation.failedAcquire("a", b.trackId);
  automation.failedAcquire("a", a.trackId);
  expect(
    local
      .stream()
      ?.getVideoTracks()
      .map((t) => t.id),
  ).toEqual([a.trackId]);
  automation.dispose();
  expect(local.stream()).toBeNull();
});

it("cancels an in-flight share on owner exit and cannot close its replacement", async () => {
  const { local, share } = setup();
  const automation = new AutomationScreenShares(share);
  const abandoned = screen();
  let finish!: (stream: MediaStream) => void;
  let captureSignal!: AbortSignal;
  const pending = automation.start(
    "a",
    "monitor",
    signal(),
    async (signal) => {
      captureSignal = signal;
      return new Promise<MediaStream>((resolve) => {
        finish = resolve;
      });
    },
    async () => {},
  );
  const rejected = expect(pending).rejects.toThrow();
  await vi.waitFor(() =>
    expect(finish).toBeTypeOf("function"),
  );
  automation.release("a");
  expect(captureSignal.aborted).toBe(true);
  const next = automation.start(
    "new-grant",
    "monitor",
    signal(),
    async () => screen(),
    async () => {},
  );
  finish(abandoned);
  await rejected;
  const fresh = await next;
  automation.release("a");
  expect(local.stream()?.getVideoTracks()[0].id).toBe(
    fresh.trackId,
  );
  automation.dispose();
  expect(local.stream()).toBeNull();
});

it.each([true, false])(
  "serializes concurrent control and explicit sharing (control first: %s)",
  async (controlFirst) => {
    const { local, share } = setup();
    const stream = screen();
    let finish!: (stream: MediaStream) => void;
    const capture = vi.fn(
      () =>
        new Promise<MediaStream>((resolve) => {
          finish = resolve;
        }),
    );
    const first = share.start(
      "monitor",
      signal(),
      capture,
      undefined,
      controlFirst,
    );
    const second = share.start(
      "monitor",
      signal(),
      capture,
      undefined,
      !controlFirst,
    );
    await vi.waitFor(() =>
      expect(capture).toHaveBeenCalledOnce(),
    );
    finish(stream);
    const [a, b] = await Promise.all([first, second]);
    expect(capture).toHaveBeenCalledOnce();
    expect(a.trackId).toBe(b.trackId);
    expect(b.reused).toBe(true);
    a.release();
    b.release();
    expect(local.stream()?.getTracks()).toEqual(
      stream.getTracks(),
    );
    local.dispose();
  },
);
it("releases only temporary tracks after the last control owner exits", async () => {
  const { local, share } = setup();
  const camera = new Track(
    "video",
  ) as unknown as MediaStreamTrack;
  local.replace(new MediaStream([camera]));
  const stream = screen();
  const a = await share.start(
    "monitor",
    signal(),
    async () => stream,
    undefined,
    true,
  );
  const b = await share.start(
    "monitor",
    signal(),
    async () => {
      throw new Error("duplicate");
    },
    undefined,
    true,
  );
  expect(
    getMeetingVideoSourceKind(stream.getVideoTracks()[0]),
  ).toBe("screen");
  expect(
    getMeetingAudioSource(stream.getAudioTracks()[0]).kind,
  ).toBe("screen");
  a.release();
  expect(local.stream()?.getTracks()).toHaveLength(3);
  b.release();
  b.release();
  expect(local.stream()?.getTracks()).toEqual([camera]);
  for (const track of stream.getTracks())
    expect(track.stop).toHaveBeenCalledOnce();
  local.dispose();
});
it.each(["existing", "recording"])(
  "preserves %s sharing on control release",
  async (kind) => {
    const { local, share } = setup();
    const stream = screen();
    if (kind === "existing") local.replace(stream);
    const owner = await share.start(
      "monitor",
      signal(),
      async () => stream,
      undefined,
      true,
    );
    if (kind === "recording")
      share.retain(stream.getVideoTracks()[0]);
    owner.release();
    expect(local.stream()?.getTracks()).toEqual(
      stream.getTracks(),
    );
    for (const track of stream.getTracks())
      expect(track.stop).not.toHaveBeenCalled();
    local.dispose();
  },
);
it("does not let old control cleanup stop a replacement of the same source", async () => {
  const { local, share } = setup();
  const first = await share.start(
    "monitor",
    signal(),
    async () => screen(),
    undefined,
    true,
  );
  local.clear();
  const second = await share.start(
    "monitor",
    signal(),
    async () => screen(),
    undefined,
    true,
  );
  first.release();
  expect(local.stream()?.getVideoTracks()[0].id).toBe(
    second.trackId,
  );
  second.release();
  expect(local.stream()).toBeNull();
});
it("disposes canceled captures and allows a queued independent caller to proceed", async () => {
  const { local, share } = setup();
  const abort = new AbortController();
  const abandoned = screen(),
    replacement = screen();
  let finish!: (stream: MediaStream) => void;
  const capture = vi.fn(
    () =>
      new Promise<MediaStream>((resolve) => {
        finish = resolve;
      }),
  );
  const first = share.start(
    "monitor",
    abort.signal,
    capture,
    undefined,
    true,
  );
  const rejected = expect(first).rejects.toThrow();
  const second = share.start(
    "monitor",
    signal(),
    async () => replacement,
  );
  await vi.waitFor(() =>
    expect(capture).toHaveBeenCalledOnce(),
  );
  abort.abort();
  finish(abandoned);
  await rejected;
  const result = await second;
  expect(result.reused).toBe(false);
  for (const track of abandoned.getTracks())
    expect(track.stop).toHaveBeenCalledOnce();
  expect(local.stream()?.getTracks()).toEqual(
    replacement.getTracks(),
  );
  local.dispose();
});
