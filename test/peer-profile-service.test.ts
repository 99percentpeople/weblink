import { describe, expect, it, vi } from "vitest";
import type { PeerSession } from "@/libs/core/session";
import { RTC_PROFILE_PROTOCOL_VERSION } from "@/libs/core/profile";
import { createClientPresence } from "@/libs/core/services/client/client-presence";
import type { TransferClient } from "@/libs/core/services/type";
import {
  RtcProtocol,
  type ClientProfileMessage,
  type RtcProtocolTransport,
  type SessionMessage,
} from "@/libs/services/rtc-protocol";
import { PeerProfileService } from "@/libs/services/peer-profile-service";

class FakeTransport implements RtcProtocolTransport {
  readonly sendCalls: Array<{
    session: PeerSession;
    message: SessionMessage;
  }> = [];

  private readonly handlers = new Set<
    (context: {
      session: PeerSession;
      message: SessionMessage;
    }) => unknown
  >();

  send(session: PeerSession, message: SessionMessage) {
    this.sendCalls.push({ session, message });
  }

  onAny(
    handler: (context: {
      session: PeerSession;
      message: SessionMessage;
    }) => unknown,
  ) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(session: PeerSession, message: SessionMessage) {
    for (const handler of this.handlers) {
      handler({ session, message });
    }
  }
}

class FakeSession {
  readonly clientId = "local";
  readonly targetClientId = "remote";
  isMessageChannelReady = false;

  private readonly listeners = new Map<
    string,
    Set<(event: { detail: unknown }) => void>
  >();

  addEventListener(
    event: string,
    handler: (event: { detail: unknown }) => void,
    options?: AddEventListenerOptions | boolean,
  ) {
    const handlers = this.listeners.get(event) ?? new Set();
    handlers.add(handler);
    this.listeners.set(event, handlers);

    if (typeof options !== "boolean" && options?.signal) {
      options.signal.addEventListener(
        "abort",
        () => handlers.delete(handler),
        { once: true },
      );
    }
  }

  emit(event: string, detail: unknown) {
    for (const handler of this.listeners.get(event) ?? []) {
      handler({ detail });
    }
  }
}

const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("client signaling presence", () => {
  it("replaces real profile data with an anonymous placeholder", () => {
    const client: TransferClient = {
      clientId: "12345678-abcd-efgh",
      name: "Private name",
      avatar: "data:image/png;base64,private",
      createdAt: 42,
    };

    const presence = createClientPresence(client, true);

    expect(presence).toEqual({
      clientId: client.clientId,
      name: "Peer-12345678",
      avatar: null,
      createdAt: 42,
      rtcProfileVersion: RTC_PROFILE_PROTOCOL_VERSION,
      resume: true,
    });
    expect(createClientPresence(client)).not.toHaveProperty(
      "resume",
    );
    expect(client.name).toBe("Private name");
    expect(client.avatar).toContain("private");
  });
});

describe("PeerProfileService", () => {
  it("sends the real profile after the RTC message channel opens", () => {
    const dateNow = vi
      .spyOn(Date, "now")
      .mockReturnValue(100);
    const transport = new FakeTransport();
    const protocol = new RtcProtocol(transport);
    const session = new FakeSession();
    const service = new PeerProfileService(protocol, {
      getLocalClient: () => ({
        clientId: "local",
        name: "Alice",
        avatar: "data:image/png;base64,avatar",
      }),
      onRemoteClient: vi.fn(),
    });

    service.bindSession(session as unknown as PeerSession);
    expect(transport.sendCalls).toHaveLength(0);

    session.isMessageChannelReady = true;
    session.emit("messagechannelchange", "ready");

    expect(transport.sendCalls).toHaveLength(1);
    expect(transport.sendCalls[0]!.message).toMatchObject({
      type: "client-profile",
      version: RTC_PROFILE_PROTOCOL_VERSION,
      client: "local",
      target: "remote",
      profile: {
        name: "Alice",
        avatar: "data:image/png;base64,avatar",
      },
    });

    service.dispose();
    dateNow.mockRestore();
  });

  it("accepts only profiles matching the bound RTC peers", async () => {
    const transport = new FakeTransport();
    const protocol = new RtcProtocol(transport);
    const session = new FakeSession();
    const onRemoteClient = vi.fn();
    const service = new PeerProfileService(protocol, {
      getLocalClient: () => ({
        clientId: "local",
        name: "Alice",
        avatar: null,
      }),
      onRemoteClient,
    });
    service.bindSession(session as unknown as PeerSession);

    const profileMessage = {
      id: "profile-1",
      type: "client-profile",
      version: RTC_PROFILE_PROTOCOL_VERSION,
      createdAt: 10,
      client: "remote",
      target: "local",
      profile: {
        name: "Bob",
        avatar: "data:image/png;base64,bob",
      },
    } satisfies ClientProfileMessage;

    transport.emit(
      session as unknown as PeerSession,
      profileMessage,
    );
    await flush();

    expect(onRemoteClient).toHaveBeenCalledWith({
      clientId: "remote",
      name: "Bob",
      avatar: "data:image/png;base64,bob",
    });

    transport.emit(session as unknown as PeerSession, {
      ...profileMessage,
      id: "profile-2",
      createdAt: 11,
      client: "different-client",
    });
    await flush();

    expect(onRemoteClient).toHaveBeenCalledTimes(1);
    service.dispose();
  });
});
