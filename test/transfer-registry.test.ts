// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { TransferMode } from "@/libs/domain/transfer/file-transferer";
import { findMessageTransfer } from "@/libs/application/transfer/file-transfer-state";
import {
  deferred,
  flushRtc,
} from "./helpers/rtc-transport";
import {
  fakeCache,
  fakeChannel,
  fileMessage,
  fileSession,
  registryFixture,
} from "./helpers/file-transfer";

let fixture: ReturnType<typeof registryFixture>;
beforeEach(() => {
  vi.useFakeTimers();
  fixture = registryFixture();
});
afterEach(async () => {
  fixture.registry.clear();
  await flushRtc();
  vi.useRealTimers();
});

describe("session-owned file transfers", () => {
  it("sends the same cache to two peers without replacing either run", () => {
    const cache = fakeCache();
    const a = fixture.register(
      fileSession("a"),
      cache,
      "ma",
    );
    const b = fixture.register(
      fileSession("b"),
      cache,
      "mb",
    );
    expect(Object.values(fixture.state)).toHaveLength(2);
    expect(a.transferer).not.toBe(b.transferer);
    expect(fixture.created[0].closed).toBe(false);
    expect(
      findMessageTransfer(
        fixture.state,
        fileMessage("ma", "a"),
      )?.id,
    ).toBe(a.id);
    expect(
      findMessageTransfer(
        fixture.state,
        fileMessage("ma", "b"),
      ),
    ).toBeUndefined();
  });
  it("refuses a second transfer for the same session/file without destroying the first", () => {
    const session = fileSession();
    const cache = fakeCache();
    const run = fixture.register(session, cache);
    expect(() =>
      fixture.register(session, cache, "other"),
    ).toThrow(/active transfer/);
    expect(fixture.registry.get(session, cache.id)).toBe(
      run,
    );
    expect(fixture.created[0].closed).toBe(false);
  });
  it("does not allow concurrent writers to the same file cache", () => {
    const cache = fakeCache();
    fixture.register(
      fileSession("a"),
      cache,
      "a",
      TransferMode.Receive,
    );
    expect(() =>
      fixture.register(
        fileSession("b"),
        cache,
        "b",
        TransferMode.Receive,
      ),
    ).toThrow(/cache writer/);
    expect(() =>
      fixture.register(
        fileSession("b"),
        cache,
        "b",
        TransferMode.Send,
      ),
    ).toThrow(/cache writer/);
  });
  it("drops unknown and wrong-session channels rather than buffering them for later", async () => {
    const a = fileSession("a"),
      b = fileSession("b");
    const unknown = fakeChannel();
    fixture.registry.acceptChannel(b, "file", unknown);
    expect(unknown.close).toHaveBeenCalledOnce();
    const run = fixture.register(a);
    const wrong = fakeChannel();
    fixture.registry.acceptChannel(b, "file", wrong);
    expect(wrong.close).toHaveBeenCalledOnce();
    await fixture.registry.initialize(run);
    expect(run.transferer.channel).toBeNull();
  });
  it("buffers one channel only for a known run and attaches after initialization", async () => {
    const session = fileSession();
    const run = fixture.register(session);
    const ready = deferred<void>();
    fixture.created[0].initialize.mockReturnValue(
      ready.promise,
    );
    const initialization = fixture.registry.initialize(run);
    const first = fakeChannel(),
      extra = fakeChannel();
    fixture.registry.acceptChannel(session, "file", first);
    fixture.registry.acceptChannel(session, "file", extra);
    expect(extra.close).toHaveBeenCalledOnce();
    expect(
      fixture.created[0].setChannel,
    ).not.toHaveBeenCalled();
    ready.resolve();
    await initialization;
    expect(
      fixture.created[0].setChannel,
    ).toHaveBeenCalledTimes(1);
    expect(
      fixture.created[0].setChannel,
    ).toHaveBeenCalledWith(first);
  });
  it("rejects unsolicited remote channels for a locally-created channel run", async () => {
    const session = fileSession();
    const run = fixture.registry.register({
      session,
      cache: fakeCache(),
      messageId: "m",
      mode: TransferMode.Send,
      incomingChannel: false,
    });
    const channel = fakeChannel();
    fixture.registry.acceptChannel(
      session,
      "file",
      channel,
    );
    expect(channel.close).toHaveBeenCalledOnce();
    await fixture.registry.initialize(run);
    const own = fakeChannel();
    fixture.registry.setChannel(run, own);
    expect(run.transferer.channel).toBe(own);
  });
  it("isolates replacement sessions even when their peer ID is identical", async () => {
    const oldSession = fileSession(),
      newSession = fileSession();
    const old = fixture.register(oldSession);
    fixture.registry.closeSession(oldSession);
    const next = fixture.register(
      newSession,
      fakeCache(),
      "next",
    );
    const late = fakeChannel();
    fixture.registry.setChannel(old, late);
    fixture.registry.closeSession(oldSession);
    expect(late.close).toHaveBeenCalledOnce();
    expect(fixture.registry.get(newSession, "file")).toBe(
      next,
    );
    expect(fixture.created[1].closed).toBe(false);
  });
  it("does not attach a queued channel when cancellation wins initialization", async () => {
    const run = fixture.register();
    const pending = deferred<void>();
    fixture.created[0].initialize.mockReturnValue(
      pending.promise,
    );
    const initialized = fixture.registry.initialize(run);
    const result = initialized.catch(
      (error: Error) => error,
    );
    const channel = fakeChannel();
    fixture.registry.setChannel(run, channel);
    fixture.registry.destroy(run);
    pending.resolve();
    expect(await result).toMatchObject({
      name: "AbortError",
    });
    expect(channel.close).toHaveBeenCalledOnce();
    expect(
      fixture.created[0].setChannel,
    ).not.toHaveBeenCalled();
  });
  it("times out a run that never acquires its data channel", async () => {
    fixture.messages.messages = [fileMessage()];
    const run = fixture.register();
    await fixture.registry.initialize(run);
    await vi.advanceTimersByTimeAsync(1001);
    expect(
      fixture.registry.get(run.session, "file"),
    ).toBeUndefined();
    expect(fixture.messages.messages[0]).toMatchObject({
      transferStatus: "error",
      error: "file transfer channel timeout",
    });
    expect(vi.getTimerCount()).toBe(0);
  });
  it("does not let late completion of an old receiver remove a newer run", async () => {
    const cache = fakeCache(),
      session = fileSession();
    const assembling = deferred<File | null>();
    cache.getFile.mockReturnValue(assembling.promise);
    fixture.messages.messages = [
      fileMessage("old"),
      fileMessage("new"),
    ];
    const old = fixture.register(
      session,
      cache,
      "old",
      TransferMode.Receive,
    );
    await fixture.registry.initialize(old);
    fixture.created[0].finish();
    await flushRtc();
    fixture.registry.destroy(old);
    const next = fixture.register(
      session,
      cache,
      "new",
      TransferMode.Receive,
    );
    assembling.resolve(new File(["ok"], "result"));
    await flushRtc();
    expect(fixture.registry.get(session, cache.id)).toBe(
      next,
    );
    expect(
      fixture.messages.messages[1].transferStatus,
    ).toBe("paused");
    expect(fixture.created[1].closed).toBe(false);
  });
  it("surfaces a final cache assembly failure", async () => {
    const cache = fakeCache();
    cache.getFile.mockResolvedValue(null);
    fixture.messages.messages = [fileMessage()];
    const run = fixture.register(
      fileSession(),
      cache,
      "message",
      TransferMode.Receive,
    );
    await fixture.registry.initialize(run);
    fixture.created[0].finish();
    await flushRtc();
    expect(
      fixture.messages.messages[0].transferStatus,
    ).toBe("error");
    expect(
      fixture.registry.get(run.session, "file"),
    ).toBeUndefined();
  });
  it("contains periodic flush failure and tears down its timer", async () => {
    fixture.messages.messages = [fileMessage()];
    const cache = fakeCache();
    cache.flush.mockRejectedValue(new Error("disk full"));
    const run = fixture.register(
      fileSession(),
      cache,
      "message",
      TransferMode.Receive,
    );
    await fixture.registry.initialize(run);
    fixture.registry.setChannel(run, fakeChannel());
    await vi.advanceTimersByTimeAsync(1001);
    expect(fixture.messages.messages[0].error).toBe(
      "disk full",
    );
    expect(
      fixture.registry.get(run.session, "file"),
    ).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("updates by explicit message identity after earlier messages are deleted", async () => {
    fixture.messages.messages = [
      fileMessage("earlier"),
      fileMessage("target"),
      fileMessage("later"),
    ];
    const run = fixture.register(
      fileSession(),
      fakeCache(),
      "target",
    );
    await fixture.registry.initialize(run);
    fixture.messages.messages.splice(0, 1);
    fixture.created[0].dispatchEvent("progress", {
      received: 256,
      total: 2048,
    });
    expect(
      fixture.messages.messages[0].progress?.received,
    ).toBe(256);
    expect(
      fixture.messages.messages[1].progress,
    ).toBeUndefined();
    fixture.messages.messages.splice(0, 1);
    fixture.created[0].dispatchEvent("progress", {
      received: 512,
      total: 2048,
    });
    expect(
      fixture.messages.messages[0].progress,
    ).toBeUndefined();
  });
  it("stops updating messages once their transfer run is destroyed", () => {
    fixture.messages.messages = [fileMessage()];
    const run = fixture.register();
    fixture.registry.destroy(run);
    fixture.created[0].dispatchEvent("progress", {
      received: 500,
      total: 2048,
    });
    expect(
      fixture.messages.messages[0].progress,
    ).toBeUndefined();
  });
});

describe("shared file-cache leases", () => {
  it("waits for all peers to finish before automatic deletion", async () => {
    fixture.setAutoDelete(true);
    const cache = fakeCache();
    fixture.register(fileSession("a"), cache, "a");
    fixture.register(fileSession("b"), cache, "b");
    fixture.created[0].finish();
    await flushRtc();
    expect(cache.cleanup).not.toHaveBeenCalled();
    fixture.created[1].finish();
    await flushRtc();
    expect(cache.cleanup).toHaveBeenCalledOnce();
  });
  it("retains a shared cache when the remaining peer pauses or fails", async () => {
    fixture.setAutoDelete(true);
    const cache = fakeCache();
    fixture.register(fileSession("a"), cache, "a");
    const other = fixture.register(
      fileSession("b"),
      cache,
      "b",
    );
    fixture.created[0].finish();
    await flushRtc();
    fixture.registry.destroy(other);
    await flushRtc();
    expect(cache.cleanup).not.toHaveBeenCalled();
  });
  it("holds the cache while another operation is still preparing", async () => {
    fixture.setAutoDelete(true);
    const cache = fakeCache();
    const release = fixture.registry.retainCache(cache);
    fixture.register(fileSession(), cache);
    fixture.created[0].finish();
    await flushRtc();
    expect(cache.cleanup).not.toHaveBeenCalled();
    release();
    release();
    await flushRtc();
    expect(cache.cleanup).toHaveBeenCalledOnce();
    expect(() =>
      fixture.registry.retainCache(cache),
    ).toThrow(/being deleted/);
  });
  it("cancels only runs using a cache when that cache is deleted", async () => {
    const cache = fakeCache();
    const session = fileSession();
    fixture.register(session, cache);
    const other = fixture.register(
      session,
      fakeCache("other"),
      "other",
    );
    await cache.cleanup();
    expect(
      fixture.registry.get(session, "file"),
    ).toBeUndefined();
    expect(fixture.registry.get(session, "other")).toBe(
      other,
    );
  });
});

it("can delete a retained cache after its paused delivery resumes and completes", async () => {
  fixture.setAutoDelete(true);
  const cache = fakeCache();
  const paused = fixture.register(
    fileSession("a"),
    cache,
    "resume-me",
  );
  fixture.register(fileSession("b"), cache, "b");
  fixture.registry.destroy(paused);
  fixture.created[1].finish();
  await flushRtc();
  expect(cache.cleanup).not.toHaveBeenCalled();
  fixture.register(fileSession("a"), cache, "resume-me");
  fixture.created[2].finish();
  await flushRtc();
  expect(cache.cleanup).toHaveBeenCalledOnce();
});
