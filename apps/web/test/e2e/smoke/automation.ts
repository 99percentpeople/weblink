import { AutomationPeerLink } from "../../../src/libs/application/automation/peer-link";
import { AutomationPermissions } from "../../../src/libs/application/automation/permissions";
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
  const permissions = new AutomationPermissions(() => {});
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
        async (call, signal) => {
          await permissions.require(
            {
              id: right!.fingerprint,
              label: "paired browser",
              kind: "peer",
              fingerprint: right!.fingerprint,
            },
            "diagnostics.read",
            call,
            signal,
          );
          count++;
          return {
            ok: true,
            data: { payload: "x".repeat(64000) },
          };
        },
        () => {},
        () => permissions.stop(),
      );
    };
    left = new AutomationPeerLink(
      a.createDataChannel("weblink-automation/1", {
        protocol: "weblink-automation/1",
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
    assert(
      left.fingerprint === right!.fingerprint,
      "Fingerprint mismatch",
    );
    const call = {
      name: "diagnostics.snapshot",
      arguments: { target: "local" },
    };
    const pending = left.call(
      call,
      new AbortController().signal,
    );
    await wait(() => permissions.pending.size === 1);
    assert(count === 0, "Executed without approval");
    permissions.decide(
      [...permissions.pending.keys()][0],
      15,
    );
    const result = await pending;
    assert(
      result.ok &&
        result.data.payload === "x".repeat(64000),
      "Chunked result differs",
    );
    permissions.stop();
    const second = left.call(
      call,
      new AbortController().signal,
    );
    await wait(() => permissions.pending.size === 1);
    assert(count === 1, "Revoked grant reused");
    permissions.decide(
      [...permissions.pending.keys()][0],
      0,
    );
    assert(!(await second).ok, "Denied call succeeded");
    const context = webMcpContext(document);
    if (context) {
      const unregister = registerWebMcp(
        context,
        async () => ({ ok: true, data: {} }),
      );
      unregister();
    }
    window.__SPEED_TEST_REPORT__ = {
      ok: true,
      transport: "real Chromium RTCDataChannel",
      consent: true,
      revocation: true,
      chunkedOutput: true,
      webMcpRegistration: !!context,
    };
  } finally {
    left?.close();
    right?.close();
    permissions.stop();
    a.close();
    b.close();
  }
}
void main().catch(
  (error) =>
    (window.__SPEED_TEST_ERROR__ =
      error.stack ?? String(error)),
);
