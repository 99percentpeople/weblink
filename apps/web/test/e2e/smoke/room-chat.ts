import { RoomMessagingService } from "../../../src/libs/application/messaging/room-messaging-service";
import { P2PProtocol } from "../../../src/libs/domain/protocol/protocol";
import { parseSessionMessage } from "../../../src/libs/domain/protocol/validation";
import { MessageSendQueue } from "../../../src/libs/domain/session-send-queue";
import { MultiEventEmitter } from "../../../src/libs/utils/event-emitter";
import type {
  PeerSession,
  PeerSessionEventMap,
} from "../../../src/libs/domain/session";
import type { TextMessage } from "../../../src/libs/domain/message";
import type {
  ProtocolAnyMessageHandler,
  ProtocolSessionClosedHandler,
  ProtocolTransport,
} from "../../../src/libs/domain/protocol/transport";

function assert(
  value: unknown,
  message: string,
): asserts value {
  if (!value) throw new Error(`Room RTC smoke: ${message}`);
}

async function waitUntil(
  check: () => boolean,
): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > deadline)
      throw new Error("Room RTC smoke timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function participant(id: string) {
  const sessions: PeerSession[] = [];
  const queues = new Map<PeerSession, MessageSendQueue>();
  const handlers = new Set<
    ProtocolAnyMessageHandler<PeerSession>
  >();
  const closedHandlers = new Set<
    ProtocolSessionClosedHandler<PeerSession>
  >();
  const messages = new Map<string, TextMessage>();
  const behavior = { dropRoomReceipts: false };
  const transport: ProtocolTransport<PeerSession> = {
    send: async (session, message, options) => {
      if (
        behavior.dropRoomReceipts &&
        message.type === "ack" &&
        messages.has(message.id)
      )
        return;
      const queue = queues.get(session);
      if (!queue)
        throw new Error("RTC session no longer exists");
      await queue.send(message, options);
    },
    onAny: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onSessionClosed: (handler) => {
      closedHandlers.add(handler);
      return () => {
        closedHandlers.delete(handler);
      };
    },
  };
  const protocol = new P2PProtocol(transport);
  const service = new RoomMessagingService(protocol, {
    getRoom: () => ({
      roomId: "browser-room",
      namespace: "browser-smoke",
      conversationId: "room:browser-smoke:browser-room",
    }),
    getSessions: () => sessions,
    getLocalClient: () => ({
      clientId: id,
      name: `Participant ${id}`,
      avatar: null,
    }),
    store: {
      async putRoomMessage(message) {
        if (message.type !== "text")
          throw new Error("Text-only fixture");
        const existing = messages.get(message.id);
        if (existing) {
          if (
            existing.client !== message.client ||
            existing.data !== message.data ||
            existing.conversationId !==
              message.conversationId
          )
            throw new Error("Conflicting logical message");
          return false;
        }
        messages.set(message.id, structuredClone(message));
        return true;
      },
      async setRoomDelivery(messageId, peerId, status) {
        const message = messages.get(messageId);
        assert(
          message?.deliveries,
          "missing outgoing message",
        );
        message.deliveries[peerId] = status;
      },
    },
  });
  return {
    id,
    sessions,
    messages,
    protocol,
    service,
    behavior,
    endpoint(peerId: string) {
      let channel: RTCDataChannel | undefined;
      const emitter =
        new MultiEventEmitter<PeerSessionEventMap>();
      const session = {
        clientId: id,
        targetClientId: peerId,
        get isMessageChannelReady() {
          return channel?.readyState === "open";
        },
        addEventListener:
          emitter.addEventListener.bind(emitter),
      } as unknown as PeerSession;
      const queue = new MessageSendQueue(
        () => channel ?? null,
      );
      sessions.push(session);
      queues.set(session, queue);
      service.syncSessions();
      let ended = false;
      const close = () => {
        if (ended) return;
        ended = true;
        const index = sessions.indexOf(session);
        if (index !== -1) sessions.splice(index, 1);
        queue.close();
        queues.delete(session);
        for (const handler of closedHandlers)
          handler(session);
        emitter.dispatchEvent("statuschange", "closed");
        channel?.close();
      };
      return {
        bind(next: RTCDataChannel) {
          channel = next;
          const ready = () => {
            queue.flush();
            emitter.dispatchEvent(
              "messagechannelchange",
              "ready",
            );
          };
          next.addEventListener("open", ready);
          next.addEventListener("message", ({ data }) => {
            const message = parseSessionMessage(data);
            for (const handler of handlers)
              void handler({ session, message });
          });
          next.addEventListener("close", close);
          if (next.readyState === "open") ready();
        },
        close,
      };
    },
    dispose() {
      service.dispose();
      protocol.dispose();
      for (const queue of queues.values()) queue.close();
    },
  };
}

async function connect(
  a: ReturnType<typeof participant>,
  b: ReturnType<typeof participant>,
) {
  const left = new RTCPeerConnection({ iceServers: [] });
  const right = new RTCPeerConnection({ iceServers: [] });
  const aEndpoint = a.endpoint(b.id),
    bEndpoint = b.endpoint(a.id);
  const close = () => {
    aEndpoint.close();
    bEndpoint.close();
    left.close();
    right.close();
  };
  try {
    right.ondatachannel = ({ channel }) =>
      bEndpoint.bind(channel);
    aEndpoint.bind(
      left.createDataChannel("room-control", {
        ordered: false,
        protocol: "message",
      }),
    );
    await left.setLocalDescription(
      await left.createOffer(),
    );
    await waitUntil(
      () => left.iceGatheringState === "complete",
    );
    await right.setRemoteDescription(
      left.localDescription!,
    );
    await right.setLocalDescription(
      await right.createAnswer(),
    );
    await waitUntil(
      () => right.iceGatheringState === "complete",
    );
    await left.setRemoteDescription(
      right.localDescription!,
    );
    await waitUntil(
      () =>
        a.service.capabilities[b.id] === "supported" &&
        b.service.capabilities[a.id] === "supported",
    );
    return { close };
  } catch (error) {
    close();
    throw error;
  }
}

/** Three independent protocol clients in Chromium, connected by real RTC channels. */
export async function runRoomChatSmoke() {
  const [a, b, c] = [
    participant("a"),
    participant("b"),
    participant("c"),
  ];
  const links: { close(): void }[] = [];
  try {
    links.push(
      ...(await Promise.all([
        connect(a, b),
        connect(b, c),
        connect(a, c),
      ])),
    );
    await Promise.all([
      a.service.send("From a"),
      b.service.send("From b"),
      c.service.send("From c"),
    ]);
    for (const client of [a, b, c]) {
      assert(
        client.messages.size === 3,
        "full mesh message count mismatch",
      );
      const sent = [...client.messages.values()].find(
        (message) => message.client === client.id,
      )!;
      assert(
        Object.values(sent.deliveries!).every(
          (status) => status === "delivered",
        ),
        "missing per-peer receipt",
      );
    }
    c.behavior.dropRoomReceipts = true;
    await a.service.send("Receipt lost before reconnect");
    const retry = [...a.messages.values()].find(
      (message) =>
        message.data === "Receipt lost before reconnect",
    )!;
    assert(
      retry.deliveries?.b === "delivered" &&
        retry.deliveries?.c === "failed",
      "receipt failure was not isolated per recipient",
    );
    assert(
      c.messages.has(retry.id),
      "recipient did not store before its dropped receipt",
    );
    c.behavior.dropRoomReceipts = false;
    links[2].close();
    links.push(await connect(a, c));
    await a.service.retry(retry);
    assert(
      String(retry.deliveries?.c) === "delivered",
      "replacement channel retry failed",
    );
    assert(
      c.messages.size === 4 && b.messages.size === 4,
      "logical retry duplicated history",
    );
    return {
      participants: 3,
      transport:
        "three-client mesh over real Chromium RTCDataChannels",
      initialLogicalMessages: 3,
      initialPeerReceipts: 6,
      isolatedReceiptLoss: true,
      replacementChannelRetry: true,
      localHistoryDeduplication: true,
    };
  } finally {
    for (const link of links) link.close();
    for (const client of [a, b, c]) client.dispose();
  }
}
