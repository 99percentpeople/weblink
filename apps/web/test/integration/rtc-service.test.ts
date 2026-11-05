import { describe, expect, it, vi } from "vitest";
import { RtcService } from "@/libs/application/rtc/rtc-service";
import { RtcProtocol } from "@/libs/application/rtc/rtc-protocol";
import {
  createSessionMessage,
  type SessionMessage,
} from "@/libs/domain/protocol/messages";
import type { MessageSendOptions } from "@/libs/domain/protocol/errors";
import type { PeerSession } from "@/libs/domain/session";
import {
  flushRtc,
  makeSession,
  deferred,
} from "../support/rtc-transport";

class SessionEvents extends EventTarget {
  readonly clientId = "a";
  readonly targetClientId = "b";
  readonly sendMessage = vi.fn(
    async (
      _message: SessionMessage,
      _options?: MessageSendOptions,
    ) => {},
  );
  get session(): PeerSession {
    return this as unknown as PeerSession;
  }
  emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

describe("RTC transport session ownership", () => {
  it("replaces a session binding without retaining listeners for its predecessor", async () => {
    const service = new RtcService();
    const first = new SessionEvents();
    const second = new SessionEvents();
    const messages = vi.fn();
    const closed = vi.fn();
    service.onAny(messages);
    service.onSessionClosed(closed);
    service.bindSession(first.session);
    service.bindSession(first.session);
    const message = createSessionMessage(
      makeSession("b", "a"),
      "send-text",
      { data: "hello" },
    );
    first.emit("message", message);
    expect(messages).toHaveBeenCalledTimes(1);
    service.bindSession(second.session);
    expect(closed).toHaveBeenCalledWith(first.session);
    first.emit("message", message);
    second.emit("message", message);
    expect(messages).toHaveBeenCalledTimes(2);
    service.unbindAllSessions();
    expect(closed).toHaveBeenCalledTimes(2);
    second.emit("message", message);
    expect(messages).toHaveBeenCalledTimes(2);
  });

  it("rejects a pending protocol call when a bound session closes", async () => {
    const service = new RtcService();
    const session = new SessionEvents();
    const protocol = new RtcProtocol(service);
    service.bindSession(session.session);
    const pending = protocol.call(
      session.session,
      "send-text",
      { data: "hello" },
    );
    void pending.catch(() => {});
    await flushRtc();
    session.emit("statuschange", "closed");
    await expect(pending).rejects.toMatchObject({
      code: "closed",
    });
    session.emit("accesschange", true);
    await expect(
      protocol.call(session.session, "send-text", {
        data: "stale",
      }),
    ).rejects.toMatchObject({ code: "closed" });
    protocol.dispose();
    service.unbindAllSessions();
  });

  it.each(["send-text", "send-file"] as const)(
    "cancels interrupted %s requests and allows retry after access recovers on the same session",
    async (type) => {
      const service = new RtcService();
      const session = new SessionEvents();
      const protocol = new RtcProtocol(service);
      service.bindSession(session.session);
      const payload =
        type === "send-text"
          ? { data: "hello" }
          : {
              fid: "file",
              fileName: "hello.txt",
              fileSize: 5,
              chunkSize: 4,
            };
      try {
        for (let cycle = 0; cycle < 2; cycle++) {
          const options = { id: `retry-${cycle}` };
          const pending = protocol.call(
            session.session,
            type,
            payload,
            options,
          );
          const rejected = expect(
            pending,
          ).rejects.toMatchObject({
            code: "closed",
          });
          await flushRtc();
          const sendOptions =
            session.sendMessage.mock.calls.at(-1)![1]!;
          session.emit("accesschange", false);
          await rejected;
          expect(sendOptions.signal?.aborted).toBe(true);

          session.emit("accesschange", true);
          const retry = protocol.call(
            session.session,
            type,
            payload,
            options,
          );
          const received = expect(
            retry,
          ).resolves.toMatchObject({
            type: "ack",
            id: options.id,
          });
          await flushRtc();
          session.emit(
            "message",
            createSessionMessage(
              makeSession("b", "a"),
              "ack",
              { mode: "receive" },
              options,
            ),
          );
          await received;
        }
        expect(session.sendMessage).toHaveBeenCalledTimes(
          4,
        );
      } finally {
        protocol.dispose();
        service.unbindAllSessions();
      }
    },
  );

  it("aborts interrupted handlers and suppresses their late replies after access recovers", async () => {
    const service = new RtcService();
    const session = new SessionEvents();
    const protocol = new RtcProtocol(service);
    const oldWork = deferred<void>();
    const newWork = deferred<void>();
    const handler = vi
      .fn()
      .mockImplementationOnce(() => oldWork.promise)
      .mockImplementationOnce(() => newWork.promise);
    protocol.handle("send-text", handler);
    service.bindSession(session.session);
    const message = createSessionMessage(
      makeSession("b", "a"),
      "send-text",
      { data: "hello" },
    );
    try {
      session.emit("message", message);
      const oldSignal = handler.mock.calls[0]![0].signal;
      session.emit("accesschange", false);
      expect(oldSignal.aborted).toBe(true);
      session.emit("accesschange", true);
      session.emit("message", message);
      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler.mock.calls[1]![0].signal.aborted).toBe(
        false,
      );
      oldWork.resolve();
      await flushRtc();
      expect(session.sendMessage).not.toHaveBeenCalled();
      newWork.resolve();
      await flushRtc();
      expect(session.sendMessage).toHaveBeenCalledOnce();
      expect(
        session.sendMessage.mock.calls[0]![0],
      ).toMatchObject({
        type: "ack",
        id: message.id,
      });
    } finally {
      oldWork.resolve();
      newWork.resolve();
      protocol.dispose();
      service.unbindAllSessions();
    }
  });

  it("passes the asynchronous send contract and cancellation options to PeerSession", async () => {
    const service = new RtcService();
    const session = new SessionEvents();
    const message = createSessionMessage(
      session,
      "send-text",
      { data: "hello" },
    );
    const options = {
      signal: new AbortController().signal,
      sendTimeoutMs: 100,
    };
    await service.send(session.session, message, options);
    expect(session.sendMessage).toHaveBeenCalledWith(
      message,
      options,
    );
  });
});
