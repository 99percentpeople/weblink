import {
  AutomationPeerLink,
  AUTOMATION_CHANNEL,
} from "../../../src/libs/application/automation/peer-link";
import {
  webMcpContext,
  registerWebMcp,
} from "@weblink/automation/webmcp";
const assert = (ok: unknown, message: string) => {
  if (!ok) throw new Error(message);
};
const wait = async (check: () => boolean) => {
  const end = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > end)
      throw new Error("Automation check timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};
async function main() {
  const a = new RTCPeerConnection(),
    b = new RTCPeerConnection();
  let left: AutomationPeerLink | undefined,
    right: AutomationPeerLink | undefined;
  let cancelled = false;
  let count = 0;
  try {
    a.onicecandidate = (e) => {
      if (e.candidate) void b.addIceCandidate(e.candidate);
    };
    b.onicecandidate = (e) => {
      if (e.candidate) void a.addIceCandidate(e.candidate);
    };
    b.ondatachannel = (e) => {
      right = new AutomationPeerLink(
        e.channel,
        async (_call, signal) => {
          if (count > 0) {
            await new Promise<void>((resolve) =>
              signal.addEventListener(
                "abort",
                () => {
                  cancelled = true;
                  resolve();
                },
                { once: true },
              ),
            );
            return {
              ok: false,
              error: {
                code: "CANCELLED",
                message: "CANCELLED",
              },
            };
          }
          count++;
          return {
            ok: true,
            data: { payload: "x".repeat(64000) },
          };
        },
        () => {},
        () => {},
      );
    };
    left = new AutomationPeerLink(
      a.createDataChannel(AUTOMATION_CHANNEL, {
        protocol: AUTOMATION_CHANNEL,
      }),
      async () => ({ ok: true, data: {} }),
      () => {},
      () => {},
    );
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription!);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription!);
    await wait(() => !!right);
    await Promise.all([left.ready, right!.ready]);
    const call = {
      name: "diagnostics.snapshot",
      arguments: { target: "local" },
    };
    const pending = left.call(
      call,
      new AbortController().signal,
    );
    const result = await pending;
    assert(
      result.ok &&
        result.data.payload === "x".repeat(64000),
      "Chunked result differs",
    );
    const abort = new AbortController();
    const second = left.call(call, abort.signal);
    // Wait for delivery before exercising cancellation across the real channel.
    await new Promise((resolve) =>
      setTimeout(resolve, 100),
    );
    abort.abort();
    const result2 = await second;
    assert(
      !result2.ok && result2.error.code === "CANCELLED",
      "Cancellation status differs",
    );
    await wait(() => cancelled);
    assert(count === 1, "Cancelled call executed");
    const context = webMcpContext(document);
    if (context) {
      const unregister = await registerWebMcp(
        context,
        async () => ({ ok: true, data: {} }),
      );
      unregister();
    }
    window.__SPEED_TEST_REPORT__ = {
      ok: true,
      transport: "real Chromium RTCDataChannel",
      cancellation: true,
      chunkedOutput: true,
      webMcpRegistration: !!context,
    };
  } finally {
    left?.close();
    right?.close();
    a.close();
    b.close();
  }
}
void main().catch(
  (error) =>
    (window.__SPEED_TEST_ERROR__ =
      error.stack ?? String(error)),
);
