// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  PeerSession,
  type PeerSessionOptions,
} from "@/libs/domain/session";
import type { PeerSessionChannelController } from "@/libs/domain/session-channels";
import type { SignalingService } from "@/libs/domain/signaling";
import { PeerCapabilitiesService } from "@/libs/application/peer-capabilities";
import { requiredMessageFeatures } from "@/libs/domain/protocol/protocol-versions";
import {
  createSessionMessage,
  type SessionMessage,
} from "@/libs/domain/protocol/messages";
import { MultiEventEmitter } from "@/libs/utils/event-emitter";
import type { SignalingServiceEventMap } from "@/libs/domain/signaling";
import { flushRtc } from "../support/rtc-transport";

class Channel extends EventTarget {
  id = 0;
  label = "message";
  protocol = "message";
  readyState = "open";
  bufferedAmount = 0;
  sent: SessionMessage[] = [];
  send(raw: string) {
    this.sent.push(JSON.parse(raw));
  }
  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
  receive(message: SessionMessage) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify(message),
      }),
    );
  }
}
const cleanup: (() => void)[] = [];
afterEach(() =>
  cleanup.splice(0).forEach((close) => close()),
);

function setup(
  acceptMessage?: PeerSessionOptions["acceptMessage"],
) {
  const events =
    new MultiEventEmitter<SignalingServiceEventMap>();
  const sender: SignalingService = {
    clientId: "local",
    targetClientId: "remote",
    status: "connected",
    sendSignal: async () => {},
    close: () => {},
    addEventListener: events.addEventListener.bind(events),
    removeEventListener:
      events.removeEventListener.bind(events),
  };
  const capabilities = new PeerCapabilitiesService(() => ({
    messaging: {},
    files: { content: true, shared: true },
  }));
  const session = new PeerSession(sender, {
    acceptMessage,
    authorizeMessage: (peer, message, signal) => {
      const features = requiredMessageFeatures(
        message.type,
      );
      if (features.length)
        return capabilities.require(peer, features, signal);
    },
  });
  const stop = capabilities.bind(session, () => {});
  const received: SessionMessage[] = [];
  session.addEventListener("message", ({ detail }) =>
    received.push(detail),
  );
  const channel = new Channel();
  // Substitute SCTP only; parsing, session authorization, discovery and send queue are real.
  (
    session as unknown as {
      dataChannels: PeerSessionChannelController;
    }
  ).dataChannels.acceptIncomingChannel(
    channel as unknown as RTCDataChannel,
  );
  cleanup.push(() => {
    stop();
    session.close();
  });
  const remote = {
    clientId: "remote",
    targetClientId: "local",
  };
  const announce = () =>
    channel.receive(
      createSessionMessage(remote, "peer-capabilities", {
        update: {
          kind: "snapshot",
          generation: "remote-connection",
          revision: 1,
          services: {
            "messaging/1": {},
            "files/2": { futureFormat: true },
          },
        },
      }),
    );
  return {
    session,
    capabilities,
    channel,
    received,
    remote,
    announce,
  };
}

it("blocks incompatible requests in both directions while the same connection keeps chatting", async () => {
  const s = setup();
  s.announce();
  const file = {
    fid: "file",
    fileName: "note.txt",
    fileSize: 10,
    chunkSize: 1024,
  };
  await expect(
    s.session.sendMessage(
      createSessionMessage(s.session, "send-file", file),
    ),
  ).rejects.toMatchObject({ code: "unsupported-protocol" });
  const rejected = createSessionMessage(
    s.remote,
    "send-file",
    file,
  );
  s.channel.receive(rejected);
  s.channel.receive(
    createSessionMessage(s.remote, "send-text", {
      data: "incoming",
    }),
  );
  await s.session.sendMessage(
    createSessionMessage(s.session, "send-text", {
      data: "outgoing",
    }),
  );
  await flushRtc();
  expect(
    s.received.some((m) => m.type === "send-file"),
  ).toBe(false);
  expect(s.channel.sent).toContainEqual(
    expect.objectContaining({
      id: rejected.id,
      type: "error",
      error: "unsupported-protocol",
    }),
  );
  expect(
    s.channel.sent.some((m) => m.type === "send-file"),
  ).toBe(false);
  expect(s.received).toContainEqual(
    expect.objectContaining({
      type: "send-text",
      data: "incoming",
    }),
  );
  expect(s.channel.sent).toContainEqual(
    expect.objectContaining({
      type: "send-text",
      data: "outgoing",
    }),
  );
  expect(
    s.channel.sent.filter(
      (m) => m.type === "peer-capabilities",
    ),
  ).toHaveLength(1);
  expect(s.session.isMessageChannelReady).toBe(true);
});

it("waits for the initial exchange without sending feature data or requiring a second handshake", async () => {
  const s = setup();
  const sending = s.session.sendMessage(
    createSessionMessage(s.session, "send-text", {
      data: "queued",
    }),
  );
  s.channel.receive(
    createSessionMessage(s.remote, "send-text", {
      data: "early",
    }),
  );
  await flushRtc();
  expect(
    s.channel.sent.every(
      (m) => m.type === "peer-capabilities",
    ),
  ).toBe(true);
  expect(s.received).toHaveLength(0);
  s.announce();
  await sending;
  await flushRtc();
  expect(s.received).toContainEqual(
    expect.objectContaining({
      type: "send-text",
      data: "early",
    }),
  );
  expect(s.channel.sent).toContainEqual(
    expect.objectContaining({
      type: "send-text",
      data: "queued",
    }),
  );
});

it("silently drops hidden control RPCs without interfering with chat or generating protocol errors", async () => {
  const accept = vi.fn(
    (message: SessionMessage) =>
      !requiredMessageFeatures(message.type).includes(
        "control",
      ),
  );
  const s = setup(accept);
  s.announce();
  const hidden = createSessionMessage(
    s.remote,
    "remote-clipboard",
    {
      action: "read",
      grantId: "invented",
      operationId: "operation",
    },
  );
  s.channel.receive(hidden);
  s.channel.receive(
    createSessionMessage(s.remote, "send-text", {
      data: "still chatting",
    }),
  );
  await flushRtc();
  expect(accept).toHaveBeenCalledWith(hidden);
  expect(
    s.received.some((message) => message.id === hidden.id),
  ).toBe(false);
  expect(
    s.channel.sent.some(
      (message) => message.id === hidden.id,
    ),
  ).toBe(false);
  expect(s.received).toContainEqual(
    expect.objectContaining({
      type: "send-text",
      data: "still chatting",
    }),
  );
});

it("suppresses even an unsupported-protocol reply if control is hidden while discovery is pending", async () => {
  let exposed = true;
  const s = setup(
    (message) =>
      exposed ||
      !requiredMessageFeatures(message.type).includes(
        "control",
      ),
  );
  const request = createSessionMessage(
    s.remote,
    "remote-clipboard",
    {
      action: "read",
      grantId: "invented",
      operationId: "operation",
    },
  );
  s.channel.receive(request);
  exposed = false;
  s.announce();
  await flushRtc();
  expect(
    s.received.some((message) => message.id === request.id),
  ).toBe(false);
  expect(
    s.channel.sent.some(
      (message) => message.id === request.id,
    ),
  ).toBe(false);
});
