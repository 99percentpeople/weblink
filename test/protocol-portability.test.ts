import { describe, expect, it } from "vitest";
import {
  P2PProtocol,
  createSessionMessage,
  type ProtocolAnyMessageHandler,
  type ProtocolSessionClosedHandler,
  type ProtocolTransport,
  type SessionMessage,
} from "@/libs/domain/protocol";

type PortableSession = {
  clientId: string;
  targetClientId: string;
  transportKey: string;
};

class PortableTransport implements ProtocolTransport<PortableSession> {
  readonly sent: SessionMessage[] = [];
  private readonly incoming = new Set<
    ProtocolAnyMessageHandler<PortableSession>
  >();
  private readonly closed = new Set<
    ProtocolSessionClosedHandler<PortableSession>
  >();

  async send(
    _session: PortableSession,
    message: SessionMessage,
  ): Promise<void> {
    this.sent.push(message);
  }

  onAny(
    handler: ProtocolAnyMessageHandler<PortableSession>,
  ): () => void {
    this.incoming.add(handler);
    return () => this.incoming.delete(handler);
  }

  onSessionClosed(
    handler: ProtocolSessionClosedHandler<PortableSession>,
  ): () => void {
    this.closed.add(handler);
    return () => this.closed.delete(handler);
  }

  async emit(
    session: PortableSession,
    message: SessionMessage,
  ): Promise<void> {
    await Promise.all(
      [...this.incoming].map((handler) =>
        handler({ session, message }),
      ),
    );
  }
}

describe("portable P2P protocol", () => {
  it("runs request/reply state without PeerSession or WebRTC objects", async () => {
    const transport = new PortableTransport();
    const protocol = new P2PProtocol(transport);
    const local: PortableSession = {
      clientId: "native-a",
      targetClientId: "native-b",
      transportKey: "socket-42",
    };
    const remote = {
      clientId: "native-b",
      targetClientId: "native-a",
    };

    const pending = protocol.call(
      local,
      "send-text",
      { data: "portable" },
      { id: "portable-1", createdAt: 1 },
    );

    expect(transport.sent[0]).toMatchObject({
      id: "portable-1",
      type: "send-text",
      client: "native-a",
      target: "native-b",
      data: "portable",
    });

    await transport.emit(
      local,
      createSessionMessage(
        remote,
        "ack",
        { mode: "receive" },
        { id: "portable-1", createdAt: 2 },
      ),
    );

    await expect(pending).resolves.toMatchObject({
      type: "ack",
      id: "portable-1",
    });

    protocol.dispose();
  });
});
