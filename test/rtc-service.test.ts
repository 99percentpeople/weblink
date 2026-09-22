import { describe, expect, it, vi } from "vitest";
import { RtcService } from "@/libs/application/rtc/rtc-service";
import { RtcProtocol } from "@/libs/application/rtc/rtc-protocol";
import { createSessionMessage } from "@/libs/domain/protocol/messages";
import type { PeerSession } from "@/libs/domain/session";
import {
  flushRtc,
  makeSession,
} from "./helpers/rtc-transport";

class SessionEvents extends EventTarget {
  readonly clientId = "a";
  readonly targetClientId = "b";
  readonly sendMessage = vi.fn(async () => {});
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
    protocol.dispose();
    service.unbindAllSessions();
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
