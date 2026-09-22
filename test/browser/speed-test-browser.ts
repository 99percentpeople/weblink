import {
  createSpeedTestChannel,
  runSpeedTest,
} from "../../src/libs/domain/speed-test";
import {
  SPEED_TEST_PROTOCOL,
  type SpeedTestResult,
} from "../../src/libs/domain/speed-test-protocol";

declare global {
  interface Window {
    __SPEED_TEST_REPORT__?: unknown;
    __SPEED_TEST_ERROR__?: string;
  }
}

type Outcome =
  | { result: SpeedTestResult; error?: never }
  | { error: string; result?: never };
const outcome = (
  promise: Promise<SpeedTestResult>,
): Promise<Outcome> =>
  promise.then(
    (result) => ({ result }),
    (error) => ({ error: error.code ?? String(error) }),
  );
const assert = (value: unknown, message: string) => {
  if (!value) throw new Error(message);
};

function waitUntil(
  test: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const check = () => {
      if (test()) return resolve();
      if (performance.now() - start > timeoutMs)
        return reject(new Error("Browser test timed out"));
      setTimeout(check, 10);
    };
    check();
  });
}

async function main() {
  const a = new RTCPeerConnection({ iceServers: [] });
  const b = new RTCPeerConnection({ iceServers: [] });
  let remoteMessage: RTCDataChannel | undefined;
  let mode: "approve" | "decline" | "pending" | "old" =
    "approve";
  const diagnostics: RTCDataChannel[] = [];
  let remoteOutcome: Promise<Outcome> | undefined;
  b.ondatachannel = ({ channel }) => {
    if (channel.protocol === "message") {
      remoteMessage = channel;
      channel.onmessage = (event) =>
        channel.send(event.data);
      return;
    }
    assert(
      channel.protocol === SPEED_TEST_PROTOCOL,
      "unexpected diagnostic protocol",
    );
    diagnostics.push(channel);
    if (mode === "old") return;
    remoteOutcome = outcome(
      runSpeedTest(channel, "responder", {
        maxMessageSize: b.sctp?.maxMessageSize,
        approve: () =>
          mode === "pending"
            ? new Promise(() => {})
            : Promise.resolve(mode === "approve"),
      }),
    );
  };
  const message = a.createDataChannel("message", {
    protocol: "message",
    ordered: true,
  });
  try {
    await a.setLocalDescription(await a.createOffer());
    await waitUntil(
      () => a.iceGatheringState === "complete",
    );
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer());
    await waitUntil(
      () => b.iceGatheringState === "complete",
    );
    await a.setRemoteDescription(b.localDescription!);
    await waitUntil(
      () =>
        a.connectionState === "connected" &&
        b.connectionState === "connected" &&
        message.readyState === "open",
    );

    const results = [];
    for (const bytes of [
      2 * 1024 * 1024 + 17,
      64 * 1024 * 1024,
    ]) {
      remoteOutcome = undefined;
      const channel = createSpeedTestChannel(a);
      diagnostics.push(channel);
      const local = await runSpeedTest(
        channel,
        "initiator",
        {
          maxBytes: bytes,
          maxMessageSize: a.sctp?.maxMessageSize,
        },
      );
      assert(remoteOutcome, "missing responder");
      const remote = await remoteOutcome!;
      assert(
        !remote.error,
        `responder failed: ${remote.error}`,
      );
      assert(
        local.upload.bytes > 0 &&
          local.upload.bytes <= bytes,
        "upload cap",
      );
      assert(
        local.download.bytes > 0 &&
          local.download.bytes <= bytes,
        "download cap",
      );
      assert(
        local.upload.bytes ===
          remote.result!.download.bytes,
        "upload receipt mismatch",
      );
      assert(
        local.download.bytes ===
          remote.result!.upload.bytes,
        "download receipt mismatch",
      );
      assert(
        local.upload.durationMs ===
          remote.result!.download.durationMs,
        "receiver clock mismatch",
      );
      if (bytes < 64 * 1024 * 1024)
        assert(
          local.upload.bytes === bytes &&
            local.download.bytes === bytes,
          "partial packet lost",
        );
      results.push({ maxBytes: bytes, ...local });
    }

    mode = "decline";
    const declined = await outcome(
      runSpeedTest(createSpeedTestChannel(a), "initiator"),
    );
    assert(
      declined.error === "declined",
      `decline failed: ${declined.error}`,
    );
    await remoteOutcome;

    mode = "pending";
    const controller = new AbortController();
    const cancellation = outcome(
      runSpeedTest(createSpeedTestChannel(a), "initiator", {
        signal: controller.signal,
      }),
    );
    const timer = setTimeout(() => controller.abort(), 200);
    try {
      assert(
        (await cancellation).error === "cancelled",
        "cancellation failed",
      );
      await remoteOutcome;
    } finally {
      clearTimeout(timer);
    }

    mode = "old";
    const unsupported = await outcome(
      runSpeedTest(createSpeedTestChannel(a), "initiator"),
    );
    assert(
      unsupported.error === "unsupported",
      "old peer not detected",
    );
    await waitUntil(() =>
      diagnostics.every(
        (channel) => channel.readyState === "closed",
      ),
    );

    // The diagnostic must not close or consume the session's chat channel.
    const echo = new Promise<string>((resolve) => {
      message.addEventListener(
        "message",
        (event) => resolve(event.data),
        { once: true },
      );
    });
    message.send("chat-still-works");
    assert(
      (await echo) === "chat-still-works",
      "chat channel affected",
    );
    assert(
      a.connectionState === "connected" &&
        remoteMessage?.readyState === "open",
      "peer connection affected",
    );

    let route = "unknown";
    let rttMs: number | undefined;
    const stats = await a.getStats();
    stats.forEach((report) => {
      if (report.type !== "transport") return;
      const pair = stats.get(
        report.selectedCandidatePairId,
      );
      if (!pair) return;
      route = `${stats.get(pair.localCandidateId)?.candidateType} -> ${stats.get(pair.remoteCandidateId)?.candidateType}`;
      rttMs = pair.currentRoundTripTime * 1000;
    });
    return {
      ok: true,
      browser: navigator.userAgent,
      route,
      rttMs,
      results,
      declined: true,
      cancelled: true,
      oldPeer: true,
      diagnosticsClosed: true,
      chatUnaffected: true,
    };
  } finally {
    a.close();
    b.close();
  }
}

main()
  .then((report) => {
    window.__SPEED_TEST_REPORT__ = report;
    document.querySelector("#result")!.textContent =
      JSON.stringify(report, null, 2);
  })
  .catch((error) => {
    window.__SPEED_TEST_ERROR__ = String(
      error?.stack ?? error,
    );
    document.querySelector("#result")!.textContent =
      window.__SPEED_TEST_ERROR__;
  });
