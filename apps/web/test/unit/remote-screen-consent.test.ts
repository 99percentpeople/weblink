import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { RemoteScreenConsent } from "@/libs/application/remote-screen-consent";
import { ScreenControlRequest } from "@/libs/domain/native-screen/control-request";
import type {
  RemotePointer,
  PointerState,
} from "@/libs/domain/remote-control/pointer";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it("waits for approval, shares once, and binds one-use consent to peer generation and source", async () => {
  const consent = new RemoteScreenConsent();
  consent.share = vi.fn(async () => "screen-1");
  const request = consent.request(
    "alice",
    "peer-1",
    new AbortController().signal,
  );
  expect(consent.share).not.toHaveBeenCalled();
  const id = consent.pending()!.consentId;
  await consent.respond("stale", true);
  expect(consent.share).not.toHaveBeenCalled();
  await consent.respond(id, true);
  expect(await request).toBe("screen-1");
  expect(consent.share).toHaveBeenCalledTimes(1);
  expect(consent.consume("bob", "peer-1", "screen-1")).toBe(
    false,
  );
  expect(
    consent.consume("alice", "peer-2", "screen-1"),
  ).toBe(false);
  expect(consent.consume("alice", "peer-1", "other")).toBe(
    false,
  );
  expect(
    consent.consume("alice", "peer-1", "screen-1"),
  ).toBe(true);
  expect(
    consent.consume("alice", "peer-1", "screen-1"),
  ).toBe(false);
});

it.each(["decline", "cancel", "expire", "leave"])(
  "does not capture or grant after %s",
  async (action) => {
    const consent = new RemoteScreenConsent();
    consent.share = vi.fn(async () => "screen-1");
    const abort = new AbortController();
    const request = consent.request(
      "alice",
      "peer",
      abort.signal,
    );
    const id = consent.pending()!.consentId;
    if (action === "decline")
      await consent.respond(id, false);
    if (action === "cancel") abort.abort();
    if (action === "expire")
      await vi.advanceTimersByTimeAsync(60_000);
    if (action === "leave") consent.close();
    await consent.respond(id, true);
    expect(await request).toBeUndefined();
    expect(consent.pending()).toBeNull();
    expect(consent.share).not.toHaveBeenCalled();
  },
);

it("aborts an in-flight share and refuses a late completion after peer replacement", async () => {
  const consent = new RemoteScreenConsent();
  let finish!: (id: string) => void;
  let signal!: AbortSignal;
  consent.share = vi.fn((abort) => {
    signal = abort;
    return new Promise<string>(
      (resolve) => (finish = resolve),
    );
  });
  const result = consent.request(
    "alice",
    "peer",
    new AbortController().signal,
  );
  const approval = consent.respond(
    consent.pending()!.consentId,
    true,
  );
  consent.cancelPeer("alice", "peer");
  expect(signal.aborted).toBe(true);
  finish("screen-1");
  expect(await approval).toBe(false);
  expect(await result).toBeUndefined();
  expect(consent.consume("alice", "peer", "screen-1")).toBe(
    false,
  );
});

it("keeps a failed share retryable and rejects simultaneous capture approvals", async () => {
  const consent = new RemoteScreenConsent();
  consent.share = vi
    .fn()
    .mockRejectedValueOnce(new Error("capture failed"))
    .mockResolvedValue("screen-1");
  const result = consent.request(
    "alice",
    "peer",
    new AbortController().signal,
  );
  const id = consent.pending()!.consentId;
  await expect(consent.respond(id, true)).rejects.toThrow(
    "capture failed",
  );
  expect(consent.pending()?.consentId).toBe(id);
  const approval = consent.respond(id, true);
  expect(await consent.respond(id, true)).toBe(false);
  await approval;
  expect(await result).toBe("screen-1");
});

class Pointer extends EventTarget {
  value: PointerState = "unavailable";
  state = () => this.value;
  request = vi.fn(() => this.change("requesting"));
  cancel = vi.fn(() => this.change("viewing"));
  change(state: PointerState) {
    this.value = state;
    this.dispatchEvent(new Event("change"));
  }
}

it("hands the avatar request to the matching screen when the native pointer becomes ready", () => {
  const sent: any[] = [];
  const control = new ScreenControlRequest((value) =>
    sent.push(value),
  );
  control.setAvailable(true);
  control.request();
  const id = sent[0].id;
  expect(control.state()).toBe("requesting");
  control.result({
    type: "control-result",
    id: "stale",
    sourceId: "screen",
  });
  const pointer = new Pointer();
  control.attach(
    "screen",
    pointer as unknown as RemotePointer,
  );
  expect(pointer.request).not.toHaveBeenCalled();
  control.result({
    type: "control-result",
    id,
    sourceId: "screen",
  });
  control.attach(
    "screen",
    pointer as unknown as RemotePointer,
  );
  expect(pointer.request).not.toHaveBeenCalled();
  pointer.change("viewing");
  expect(pointer.request).toHaveBeenCalledTimes(1);
  pointer.change("active");
  expect(control.state()).toBe("active");
  control.cancel();
  expect(pointer.cancel).toHaveBeenCalledOnce();
  expect(control.state()).toBe("viewing");
});

it("cancels avatar requests on timeout and ignores late results", async () => {
  const send = vi.fn();
  const control = new ScreenControlRequest(send);
  control.setAvailable(true);
  control.request();
  const id = send.mock.calls[0][0].id;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(send).toHaveBeenLastCalledWith({
    type: "control-cancel",
    id,
  });
  control.result({
    type: "control-result",
    id,
    sourceId: "screen",
  });
  const pointer = new Pointer();
  pointer.change("viewing");
  control.attach(
    "screen",
    pointer as unknown as RemotePointer,
  );
  expect(pointer.request).not.toHaveBeenCalled();
  expect(control.state()).toBe("viewing");
  control.setAvailable(false);
  expect(control.state()).toBe("unavailable");
});

it.each(["unavailable", "active"] as const)(
  "restores avatar requests when its %s screen controller is removed",
  (state) => {
    const send = vi.fn();
    const control = new ScreenControlRequest(send);
    control.setAvailable(true);
    control.request();
    const id = send.mock.calls[0][0].id;
    control.result({
      type: "control-result",
      id,
      sourceId: "screen",
    });
    const pointer = new Pointer();
    control.attach(
      "screen",
      pointer as unknown as RemotePointer,
    );
    if (state === "active") {
      pointer.change("viewing");
      pointer.change("active");
    }
    const changed = vi.fn();
    control.addEventListener("change", changed);
    control.detach(
      new Pointer() as unknown as RemotePointer,
    );
    expect(changed).not.toHaveBeenCalled();
    control.detach(pointer as unknown as RemotePointer);
    expect(changed).toHaveBeenCalledOnce();
    expect(control.state()).toBe("viewing");
    pointer.change("unavailable");
    expect(changed).toHaveBeenCalledOnce();
    control.request();
    expect(control.state()).toBe("requesting");
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toEqual({
      type: "control-request",
      id: expect.any(String),
    });
    expect(send.mock.calls[1][0].id).not.toBe(id);
    control.setAvailable(false);
    expect(control.state()).toBe("unavailable");
  },
);
