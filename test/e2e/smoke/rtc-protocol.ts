import { FileCatalogIndex } from "../../../src/libs/application/file-catalog-index";
import { runRoomChatSmoke } from "./room-chat";
import { runSessionMediaSmoke } from "./session-media";
import { RemoteFileCatalog } from "../../../src/libs/application/remote-file-catalog";
import { RtcProtocol } from "../../../src/libs/application/rtc/rtc-protocol";
import { MessageSendQueue } from "../../../src/libs/domain/session-send-queue";
import { parseSessionMessage } from "../../../src/libs/domain/protocol/validation";
import type { PeerSession } from "../../../src/libs/domain/session";
import type {
  RtcAnyMessageHandler,
  RtcProtocolTransport,
  RtcSessionClosedHandler,
} from "../../../src/libs/domain/protocol/transport";

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
  const catalog = new FileCatalogIndex();
  for (const file of files)
    catalog.update(file.id, {
      ...file,
      isComplete: true,
      isShared: true,
      sharedReference: true,
      fingerprint: {
        version: 1,
        algorithm: "blake3-256",
        digest: "0".repeat(64),
        size: file.fileSize,
      },
    });
  b.protocol.handle("request-storage", ({ message }) =>
    catalog.query(message),
  );
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
      { pageIndex: 0, pageSize: 25 },
    );
    assert(
      storage.totalCount === 1 &&
        storage.items[0]?.id === files[0].id,
      "typed storage result mismatch",
    );
    // Real DataChannel pagination/search and empty invalidation -> current-page refetch.
    for (let i = 0; i < 61; i++) {
      const id = `report-${String(i).padStart(2, "0")}`;
      catalog.update(id, {
        id,
        fileName: `${id}.txt`,
        fileSize: i + 1,
        isComplete: true,
        isShared: true,
        sharedReference: true,
        fingerprint: {
          version: 1,
          algorithm: "blake3-256",
          digest: i.toString(16).padStart(64, "0"),
          size: i + 1,
        },
      });
    }
    const view = new RemoteFileCatalog(
      {
        pageIndex: 1,
        pageSize: 10,
        search: "report",
        sort: [{ field: "fileName", desc: false }],
      },
      (query, signal) =>
        a.protocol.call(
          a.session,
          "request-storage",
          query,
          { signal },
        ),
      () => {},
      () => {},
    );
    const offChanged = a.protocol.on(
      "storage-changed",
      () => view.refresh(),
    );
    try {
      view.refresh();
      await waitUntil(
        () => view.state.page?.totalCount === 61,
      );
      assert(
        view.state.page?.items[0]?.id === "report-10",
        "wrong directory page",
      );
      catalog.update("report-10", null);
      await b.protocol.notify(
        b.session,
        "storage-changed",
        {},
      );
      await waitUntil(
        () => view.state.page?.totalCount === 60,
      );
      assert(
        view.state.page?.pageIndex === 1 &&
          view.state.page.items[0]?.id === "report-11",
        "invalidation did not refresh the current page",
      );
      view.setQuery({
        pageIndex: 0,
        pageSize: 10,
        search: "REPORT-60",
      });
      await waitUntil(
        () => view.state.page?.totalCount === 1,
      );
      assert(
        view.state.page?.items[0]?.id === "report-60",
        "search only scanned the previous page",
      );
    } finally {
      offChanged();
      view.dispose();
    }

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
      videoSources: [],
      audioSources: [],
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
      roomChat: await runRoomChatSmoke(),
      multiSourceMedia: await runSessionMediaSmoke(),
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
