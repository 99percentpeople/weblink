import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { createScreenSharing } from "@/libs/application/screen-sharing";
import { AutomationScreenShares } from "@/libs/application/automation/screen-sharing";
import { RemoteScreenConsent } from "@/libs/application/remote-screen-consent";
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

it("keeps manual close ownership with the creator across a third person's control and reuse", async () => {
  const local = createLocalStreamService();
  let controller:
    | { sourceId: string; clientId: string }
    | undefined;
  const sharing = createScreenSharing({
    stream: local.stream,
    publish: local.replace,
    controller: () => controller,
  });
  const consent = new RemoteScreenConsent();
  const capture = vi.fn(async () => screen());
  consent.share = async (signal, clientId) => {
    const shared = await sharing.start(
      "monitor",
      signal,
      capture,
      async () => {},
      true,
      clientId,
    );
    return {
      sourceId: "monitor",
      release: shared.release,
      retain: () =>
        sharing.retain(shared.stream.getVideoTracks()[0]),
      canClose: shared.canClose,
      close: shared.createdByCaller
        ? shared.close
        : undefined,
    };
  };
  const acquire = async (client: string) => {
    const pending = consent.request(
      client,
      client,
      signal(),
    );
    await consent.respond(
      consent.pending()[0].consentId,
      true,
    );
    expect(await pending).toBe("monitor");
    consent.consume(client, client, "monitor");
  };
  await acquire("alice");
  expect(
    consent.canClose("alice", "alice", "monitor"),
  ).toBe(true);
  await acquire("bob");
  controller = { sourceId: "monitor", clientId: "bob" };
  expect(capture).toHaveBeenCalledOnce();
  expect(consent.closeScreen("bob", "bob", "monitor")).toBe(
    false,
  );
  expect(
    consent.closeScreen("alice", "alice", "monitor"),
  ).toBe(false);
  expect(
    local.stream()?.getVideoTracks()[0].readyState,
  ).toBe("live");
  controller = undefined;
  expect(
    consent.closeScreen("alice", "alice", "monitor"),
  ).toBe(true);
  expect(local.stream()).toBeNull();
  consent.close();
});

it("blocks MCP closure during another controller's turn without transferring ownership to that caller", async () => {
  const local = createLocalStreamService();
  let controller:
    | { sourceId: string; clientId: string }
    | undefined;
  const sharing = createScreenSharing({
    stream: local.stream,
    publish: local.replace,
    controller: () => controller,
  });
  const automation = new AutomationScreenShares(sharing);
  const start = (caller: string) =>
    automation.start(
      caller,
      "monitor",
      signal(),
      async () => screen(),
      async () => {},
      "control",
      caller,
    );
  const a = await start("alice");
  automation.retain("alice", a.trackId);
  const b = await start("bob");
  expect(b.trackId).toBe(a.trackId);
  controller = { sourceId: "monitor", clientId: "bob" };
  expect(() => automation.stop(["bob"], b.trackId)).toThrow(
    "PERMISSION_DENIED",
  );
  expect(() =>
    automation.stop(["alice"], a.trackId),
  ).toThrow("CONTROL_BUSY");
  expect(local.stream()).not.toBeNull();
  controller = { sourceId: "monitor", clientId: "alice" };
  expect(
    automation.stop(["alice"], a.trackId).stopped,
  ).toBe(true);
  expect(local.stream()).toBeNull();
});

it("reserves a source to the host when they explicitly share an existing requested screen", async () => {
  const { local, share } = setup();
  const original = await share.start(
    "monitor",
    signal(),
    async () => screen(),
    async () => {},
    true,
    "alice",
  );
  expect(original.canClose()).toBe(true);
  const manual = await share.start(
    "monitor",
    signal(),
    async () => screen(),
  );
  expect(manual.reused).toBe(true);
  expect(original.createdByCaller).toBe(false);
  expect(original.close()).toBe(false);
  expect(local.stream()).not.toBeNull();
  share.stop(manual.stream.getVideoTracks()[0]);
  expect(local.stream()).toBeNull();
});

it("transfers a successful manual share to the room before the controller disconnects", async () => {
  const { local, share } = setup();
  const consent = new RemoteScreenConsent();
  const stream = screen();
  consent.share = async (signal) => {
    const shared = await share.start(
      "monitor",
      signal,
      async () => stream,
      async () => {},
      true,
    );
    return {
      sourceId: "monitor",
      release: shared.release,
      retain: () =>
        share.retain(stream.getVideoTracks()[0]),
    };
  };
  const request = consent.request(
    "alice",
    "peer",
    signal(),
  );
  await consent.respond(
    consent.pending()[0].consentId,
    true,
  );
  expect(await request).toBe("monitor");
  consent.consume("alice", "peer", "monitor");
  consent.synchronize(null, null);
  consent.cancelPeer("alice", "peer");
  consent.close();
  share.synchronize();
  expect(local.stream()?.getTracks()).toEqual(
    stream.getTracks(),
  );
  expect(
    stream
      .getTracks()
      .every((track) => track.readyState === "live"),
  ).toBe(true);
  share.stop(stream.getVideoTracks()[0]);
  expect(local.stream()).toBeNull();
});

it.each(["screen", "control"] as const)(
  "keeps an established %s picture after control and permission lifetime end until explicit close",
  async (purpose) => {
    const { local, share } = setup();
    const automation = new AutomationScreenShares(share);
    const stream = screen();
    const first = await automation.start(
      "a",
      "monitor",
      signal(),
      async () => stream,
      async () => {},
      purpose,
      "agent",
    );
    automation.retain("a", first.trackId);
    automation.synchronize([]);
    expect(local.stream()?.getTracks()).toEqual(
      stream.getTracks(),
    );
    const capture = vi.fn(async () => screen());
    const next = await automation.start(
      "b",
      "monitor",
      signal(),
      capture,
      async () => {},
      purpose,
      "agent",
    );
    expect(next.trackId).toBe(first.trackId);
    expect(capture).not.toHaveBeenCalled();
    expect(() =>
      automation.stop(["a"], first.trackId),
    ).toThrow("PERMISSION_DENIED");
    automation.stop(["b"], next.trackId);
    expect(local.stream()).toBeNull();
    expect(
      stream
        .getTracks()
        .every((track) => track.readyState === "ended"),
    ).toBe(true);
  },
);

it.each(["screen", "control"] as const)(
  "cancels a pending %s use while keeping the other established use",
  async (purpose) => {
    const { local, share } = setup();
    const automation = new AutomationScreenShares(share);
    const first = await automation.start(
      "a",
      "monitor",
      signal(),
      async () => screen(),
      async () => {},
      purpose === "screen" ? "control" : "screen",
    );
    automation.retain("a", first.trackId);
    const abort = new AbortController();
    await automation.start(
      "a",
      "monitor",
      abort.signal,
      async () => screen(),
      async () => {},
      purpose,
    );
    abort.abort();
    automation.synchronize([]);
    expect(local.stream()?.getVideoTracks()[0].id).toBe(
      first.trackId,
    );
    local.clear();
    expect(local.stream()).toBeNull();
  },
);

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

it("cannot close a manually published screen by claiming it through automation", async () => {
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
      "screen",
      "agent",
    );
  const a = await start("permission-a");
  const b = await start("permission-b");
  expect(a.trackId).toBe(b.trackId);
  expect(() =>
    automation.stop(["foreign"], a.trackId),
  ).toThrow("PERMISSION_DENIED");
  expect(() =>
    automation.stop(["permission-a"], a.trackId),
  ).toThrow("PERMISSION_DENIED");
  automation.release("permission-b");
  expect(local.stream()).not.toBeNull();
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
      "screen",
      "agent",
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

it("keeps an established screen after both automation and manual control exit", async () => {
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
    "control",
  );
  expect(local.stream()).not.toBeNull();
  automation.retain("a", temporary.trackId);
  controlled = "monitor";
  // Manual handoff has committed before the old automation observes its lease end.
  automation.synchronize(["a"]);
  expect(local.stream()).not.toBeNull();
  controlled = undefined;
  share.synchronize();
  expect(local.stream()).not.toBeNull();
  share.stop(temporary.stream.getVideoTracks()[0]);
  expect(local.stream()).toBeNull();
});

it("keeps both shared monitors after switching control and revoking the caller", async () => {
  const { local, share } = setup();
  const automation = new AutomationScreenShares(share);
  const start = (source: string) =>
    automation.start(
      "a",
      source,
      signal(),
      async () => screen(source),
      async () => {},
      "control",
    );
  const a = await start("monitor-a");
  automation.retain("a", a.trackId);
  const b = await start("monitor-b");
  automation.retain("a", b.trackId);
  expect(
    local
      .stream()
      ?.getVideoTracks()
      .map((t) => t.id),
  ).toEqual([a.trackId, b.trackId]);
  automation.synchronize(["a"]);
  expect(local.stream()).not.toBeNull();
  automation.synchronize([]);
  expect(local.stream()).not.toBeNull();
  local.clear();
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
    "control",
  );
  automation.retain("a", a.trackId);
  const b = await automation.start(
    "a",
    "b",
    signal(),
    async () => screen("b"),
    async () => {},
    "control",
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
  expect(local.stream()).not.toBeNull();
  local.clear();
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
