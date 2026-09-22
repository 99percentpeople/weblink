import { RtcProtocol } from "../../src/libs/application/rtc/rtc-protocol";
import { MessageSendQueue } from "../../src/libs/core/protocol/send-queue";
import { parseSessionMessage } from "../../src/libs/core/protocol/validation";
import type { PeerSession } from "../../src/libs/core/session";
import type {
  RtcAnyMessageHandler,
  RtcProtocolTransport,
  RtcSessionClosedHandler,
} from "../../src/libs/core/protocol/transport";

declare global {
  interface Window {
    __SPEED_TEST_REPORT__?: unknown;
    __SPEED_TEST_ERROR__?: string;
  }
}
const assert = (condition: unknown, message: string) => {
  if (!condition) throw new Error(message);
};
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitUntil(
  check: () => boolean,
): Promise<void> {
  const deadline = performance.now() + 10_000;
  while (!check()) {
    if (performance.now() > deadline)
      throw new Error("RTC browser check timed out");
    await sleep(10);
  }
}
const outcome = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value, error: undefined }),
    (error) => ({
      value: undefined,
      error: error.code ?? String(error),
    }),
  );

function endpoint(
  clientId: string,
  targetClientId: string,
) {
  const session = {
    clientId,
    targetClientId,
  } as PeerSession;
  let channel: RTCDataChannel | null = null;
  const queue = new MessageSendQueue(() => channel);
  const handlers = new Set<RtcAnyMessageHandler>();
  const closed = new Set<RtcSessionClosedHandler>();
  const transport: RtcProtocolTransport = {
    send: (_session, message, options) =>
      queue.send(message, options),
    onAny: (handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    onSessionClosed: (handler) => {
      closed.add(handler);
      return () => {
        closed.delete(handler);
      };
    },
  };
  const protocol = new RtcProtocol(transport);
  return {
    session,
    protocol,
    bind(next: RTCDataChannel) {
      channel = next;
      next.addEventListener("open", () => queue.flush());
      next.addEventListener("message", (event) => {
        try {
          const message = parseSessionMessage(event.data);
          for (const handler of handlers)
            void handler({ session, message });
        } catch (error) {
          console.warn(
            "Rejected invalid browser-test message",
            error,
          );
        }
      });
      next.addEventListener("close", () => {
        queue.close();
        for (const handler of closed) handler(session);
      });
      queue.flush();
    },
    dispose() {
      protocol.dispose();
      queue.close();
      channel?.close();
    },
  };
}

async function main() {
  const pcA = new RTCPeerConnection({ iceServers: [] });
  const pcB = new RTCPeerConnection({ iceServers: [] });
  const a = endpoint("a", "b");
  const b = endpoint("b", "a");
  const received: string[] = [];
  const notifications: string[] = [];
  const files = [
    {
      id: "f",
      fileName: "example.txt",
      fileSize: 10,
      chunkSize: 4,
    },
  ];
  b.protocol.handle("send-text", ({ message }) => {
    received.push(message.data);
  });
  b.protocol.handle("request-storage", () => files);
  b.protocol.handle("request-file", () => {});
  b.protocol.on("stream-state", ({ message }) => {
    notifications.push(message.mode);
  });
  let clipboardStarted = false;
  b.protocol.handle(
    "send-clipboard",
    ({ signal }) =>
      new Promise<void>((resolve) => {
        clipboardStarted = true;
        signal.addEventListener("abort", () => resolve(), {
          once: true,
        });
      }),
  );
  pcB.ondatachannel = ({ channel }) => b.bind(channel);
  const channel = pcA.createDataChannel("control", {
    protocol: "message",
    ordered: true,
  });
  a.bind(channel);
  try {
    const queued = outcome(
      a.protocol.call(
        a.session,
        "send-text",
        { data: "queued" },
        { timeoutMs: 200, sendTimeoutMs: 10_000 },
      ),
    );
    const abort = new AbortController();
    const cancelled = outcome(
      a.protocol.call(
        a.session,
        "send-text",
        { data: "cancelled" },
        { signal: abort.signal },
      ),
    );
    abort.abort();
    const expired = outcome(
      a.protocol.call(
        a.session,
        "send-text",
        { data: "expired" },
        { sendTimeoutMs: 30 },
      ),
    );
    await sleep(250); // Longer than the reply deadline, while there is no open channel.
    assert(
      (await cancelled).error === "aborted",
      "queued cancellation failed",
    );
    assert(
      (await expired).error === "send-timeout",
      "queue deadline failed",
    );
    await pcA.setLocalDescription(await pcA.createOffer());
    await waitUntil(
      () => pcA.iceGatheringState === "complete",
    );
    await pcB.setRemoteDescription(pcA.localDescription!);
    await pcB.setLocalDescription(await pcB.createAnswer());
    await waitUntil(
      () => pcB.iceGatheringState === "complete",
    );
    await pcA.setRemoteDescription(pcB.localDescription!);
    assert(
      !(await queued).error,
      "reply timer started before the real send",
    );
    assert(
      received.join(",") === "queued",
      "a cancelled/expired request was sent after recovery",
    );
    const storage = await a.protocol.call(
      a.session,
      "request-storage",
      {},
    );
    assert(
      JSON.stringify(storage) === JSON.stringify(files),
      "typed storage result mismatch",
    );
    const receipt = await a.protocol.call(
      a.session,
      "request-file",
      {
        fid: "f",
        fileName: "example.txt",
        fileSize: 10,
        chunkSize: 4,
        resume: false,
      },
    );
    assert(
      receipt.mode === "send",
      "wrong file request ACK",
    );
    const concurrent = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        a.protocol.call(a.session, "send-text", {
          data: `concurrent-${index}`,
        }),
      ),
    );
    assert(
      new Set(concurrent.map((ack) => ack.id)).size === 20,
      "concurrent requests did not have distinct IDs",
    );
    assert(
      received.length === 21,
      "concurrent message loss or duplicate",
    );
    await a.protocol.notify(a.session, "stream-state", {
      mode: "media",
    });
    await waitUntil(() => notifications.length === 1);
    const interrupted = outcome(
      a.protocol.call(a.session, "send-clipboard", {
        data: "pending",
      }),
    );
    await waitUntil(() => clipboardStarted);
    channel.close();
    assert(
      (await interrupted).error === "closed",
      "channel close did not reject the pending call",
    );
    window.__SPEED_TEST_REPORT__ = {
      ok: true,
      transport: "real Chromium RTCDataChannel",
      queuedBeforeOpen: true,
      noLateCancelledOrExpiredSends: true,
      typedStorageResponse: true,
      fileRequestAckMode: receipt.mode,
      concurrentRequests: concurrent.length,
      notifications: notifications.length,
      pendingRejectedOnClose: true,
    };
  } finally {
    a.dispose();
    b.dispose();
    pcA.close();
    pcB.close();
  }
}
void main().catch((error) => {
  window.__SPEED_TEST_ERROR__ =
    error.stack ?? String(error);
});
