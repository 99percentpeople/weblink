import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  createSessionMessage,
  type SessionMessage,
} from "@/libs/domain/protocol/messages";
import type { MultiEventEmitter } from "@/libs/utils/event-emitter";
import { reconcile } from "solid-js/store";
import type { NativeControlStatus } from "@weblink/platform";
import type { ClientService } from "@/libs/domain/client";
import type {
  PeerSession,
  PeerSessionEventMap,
} from "@/libs/domain/session";
import {
  NativeScreenSession,
  type NativeScreenPublication,
} from "@/libs/domain/native-screen/session";
import { SessionService } from "@/libs/application/session-service";
import { CapabilityState } from "@/libs/domain/protocol/capability-state";
import {
  validCapabilityUpdate,
  type ControlCapability,
} from "@/libs/domain/protocol/capabilities";
import {
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { setClientConfig } from "@/libs/state/permission-options";

const api = vi.hoisted(() => ({
  open: vi.fn<() => Promise<string>>(),
  end: vi.fn(async () => {}),
  status: vi.fn<() => Promise<NativeControlStatus>>(),
  watch: vi.fn(),
  approve: vi.fn(async () => {}),
  revoke: vi.fn(async () => {}),
}));
vi.mock("@/libs/platform/runtime", () => ({
  platform: {
    kind: "desktop",
    getCapabilities: async () => ({ remoteInput: true }),
    remoteControl: api,
  },
}));
class Channel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  sent: Array<{
    type: string;
    id: string;
    control?: true;
  }> = [];
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.readyState = "closed";
  }
  receive(value: unknown) {
    const event = new Event("message");
    Object.defineProperty(event, "data", {
      value: JSON.stringify(value),
    });
    this.dispatchEvent(event);
  }
}
const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
let receive: (status: NativeControlStatus) => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  setAppState(reconcile(createInitialAppState()));
  let owner = 0;
  api.open.mockImplementation(
    async () => `owner-${++owner}`,
  );
  api.status.mockResolvedValue({
    closed: false,
    pending: [],
    clientId: null,
  });
  api.watch.mockImplementation(async (_owner, onStatus) => {
    receive = onStatus;
    onStatus(await api.status());
    return vi.fn();
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup(expectControl = true) {
  const service = new SessionService({
    loadIceServers: async () => [],
  });
  // This fixture supplies native publications directly and exercises control
  // consent after device pairing. Device gates have their own integration tests.
  vi.spyOn(service.trust, "bind").mockReturnValue(() => {});
  vi.spyOn(service, "canReceive").mockReturnValue(true);
  vi.spyOn(service, "canShareScreen").mockReturnValue(true);
  vi.spyOn(
    service as unknown as {
      applySessionStream(session: PeerSession): void;
    },
    "applySessionStream",
  ).mockImplementation(() => {});
  const clientService: ClientService = {
    info: {
      clientId: "local",
      createdAt: 1,
      name: "Local",
      avatar: null,
    },
    createSender: (targetClientId) => ({
      clientId: "local",
      targetClientId,
      status: "connected",
      sendSignal: async () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      close: () => {},
    }),
    removeSender: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    listenForJoin: () => {},
    listenForLeave: () => {},
    createClient: async () => {},
    updateClient: async () => {},
    close: () => {},
  };
  service.setClientService(clientService);
  const session = await service.addClient({
    clientId: "remote",
    createdAt: 2,
    name: "Remote",
    avatar: null,
  });
  const native = (
    service as unknown as {
      nativeScreens: Map<PeerSession, NativeScreenSession>;
    }
  ).nativeScreens.get(session)!;
  const channel = new Channel();
  native.bind(channel as unknown as RTCDataChannel);
  (
    session as unknown as Pick<
      MultiEventEmitter<PeerSessionEventMap>,
      "dispatchEvent"
    >
  ).dispatchEvent(
    "message",
    createSessionMessage(
      { clientId: "remote", targetClientId: "local" },
      "peer-capabilities",
      {
        update: {
          kind: "snapshot",
          generation: "remote-connection",
          revision: 1,
          services: {
            "screen/1": {
              decode: { video: null, audio: null },
              trickleIce: true,
              multiScreen: true,
            },
            "control/1": {
              request: true,
              host: false,
              occupancy: { state: "unavailable" },
            },
          },
        },
      },
    ),
  );
  const publication = {
    sourceId: "screen",
    controlEligible: true,
    offer: vi.fn<NativeScreenPublication["offer"]>(
      async () => "offer",
    ),
    answer: vi.fn(async () => {}),
    closePeer: vi.fn(async () => {}),
  } satisfies NativeScreenPublication;
  native.setPublication(publication);
  await flush();
  const offer = channel.sent.find(
    (value) => value.type === "offer",
  )!;
  expect(offer.control).toBe(
    expectControl ? true : undefined,
  );
  channel.receive({
    type: "answer",
    id: offer.id,
    sdp: "answer",
  });
  await flush();
  return {
    session,
    service,
    channel,
    publication,
    close() {
      service.destoryAllSession();
      service.removeService();
    },
  };
}

it.each([false, true])(
  "preserves the approved connection when remembering consent=%s",
  async (remember) => {
    api.status.mockResolvedValueOnce({
      closed: false,
      clientId: null,
      pending: [
        {
          consentId: "consent",
          clientId: "remote",
          sourceId: "screen",
        },
      ],
    });
    const fixture = await setup();
    try {
      await fixture.service.remoteControl.approve(
        "consent",
        true,
        remember,
      );
      await flush();
      expect(api.approve).toHaveBeenCalledWith(
        "owner-1",
        "consent",
        true,
      );
      expect(
        fixture.publication.closePeer,
      ).not.toHaveBeenCalled();
      expect(
        fixture.publication.offer,
      ).toHaveBeenCalledOnce();
    } finally {
      fixture.close();
    }
  },
);

it("rebuilds eligible transports for a replacement owner without replaying grants", async () => {
  const fixture = await setup();
  try {
    receive({
      closed: true,
      clientId: null,
      pending: [],
    });
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(1000);
    const offer =
      fixture.publication.offer.mock.calls.at(-1)!;
    expect(offer[4]?.ownerId).toBe("owner-2");
    expect(
      fixture.publication.closePeer,
    ).toHaveBeenCalled();
    expect(api.approve).not.toHaveBeenCalled();
    fixture.close();
    const offers =
      fixture.publication.offer.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(fixture.publication.offer).toHaveBeenCalledTimes(
      offers,
    );
  } finally {
    fixture.close();
  }
});

it("removes native control when denied and restores it when the rule is cleared", async () => {
  const fixture = await setup();
  try {
    setClientConfig("remote", { remoteControl: "deny" });
    await flush();
    expect(
      fixture.channel.sent
        .filter((value) => value.type === "offer")
        .at(-1)?.control,
    ).toBeUndefined();
    expect(
      fixture.publication.closePeer,
    ).toHaveBeenCalledOnce();
    setClientConfig("remote", { remoteControl: undefined });
    await flush();
    expect(
      fixture.channel.sent
        .filter((value) => value.type === "offer")
        .at(-1)?.control,
    ).toBe(true);
    expect(
      fixture.publication.closePeer,
    ).toHaveBeenCalledTimes(2);
  } finally {
    fixture.close();
  }
});

it("keeps unanswered requests idle and broadcasts selected, granted and released occupancy to every peer and includes it for a late join", async () => {
  const f = await setup();
  const connect = (session: PeerSession) => {
    Object.defineProperty(
      session,
      "isMessageChannelReady",
      { get: () => true },
    );
    const messages: SessionMessage[] = [];
    vi.spyOn(session, "sendMessage").mockImplementation(
      async (message) => {
        messages.push(message);
      },
    );
    (
      session as unknown as Pick<
        MultiEventEmitter<PeerSessionEventMap>,
        "dispatchEvent"
      >
    ).dispatchEvent("messagechannelchange", "ready");
    return messages;
  };
  const add = (clientId: string) =>
    f.service.addClient({
      clientId,
      createdAt: 3,
      name: clientId,
      avatar: null,
    });
  const snapshot = (messages: SessionMessage[]) => {
    const state = new CapabilityState();
    for (const value of messages)
      if (
        value.type === "peer-capabilities" &&
        validCapabilityUpdate(value.update) &&
        value.update.kind !== "request-snapshot"
      )
        state.apply(value.update);
    return state.value!["control/1"] as ControlCapability;
  };
  try {
    const first = connect(f.session);
    const second = connect(await add("other"));
    receive({
      closed: false,
      clientId: null,
      pending: [
        {
          consentId: "consent",
          clientId: "remote",
          sourceId: "screen",
        },
      ],
    });
    await flush();
    for (const messages of [first, second])
      expect(snapshot(messages).occupancy).toEqual({
        state: "idle",
      });
    await f.service.remoteControl.approve("consent", true);
    await flush();
    for (const messages of [first, second])
      expect(snapshot(messages).occupancy).toEqual({
        state: "pending",
        clientId: "remote",
        sourceId: "screen",
      });
    receive({
      closed: false,
      clientId: "remote",
      sourceId: "screen",
      grantId: "private-grant",
      pending: [],
    });
    await flush();
    const late = connect(await add("late"));
    await flush();
    for (const messages of [first, second, late]) {
      expect(snapshot(messages)).toMatchObject({
        host: true,
        occupancy: {
          state: "controlled",
          clientId: "remote",
          sourceId: "screen",
        },
      });
      expect(JSON.stringify(messages)).not.toContain(
        "private-grant",
      );
    }
    receive({
      closed: false,
      clientId: null,
      pending: [],
    });
    await flush();
    for (const messages of [first, second, late])
      expect(snapshot(messages).occupancy).toEqual({
        state: "idle",
      });
    for (const messages of [first, second, late]) {
      const updates = messages.filter(
        (m) => m.type === "peer-capabilities",
      );
      expect(updates[0]).toMatchObject({
        update: { kind: "snapshot" },
      });
      for (const message of updates.slice(1)) {
        if (!validCapabilityUpdate(message.update))
          throw new Error("Invalid capability update");
        expect(message.update.kind).toBe("patch");
        if (message.update.kind === "patch")
          expect(
            Object.keys(message.update.services),
          ).toEqual(["control/1"]);
      }
    }
    expect(f.publication.offer).toHaveBeenCalledOnce();
    expect(f.publication.closePeer).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

it("hides control discovery and requests, then patches only the affected peer when lists or exposure change", async () => {
  setAppState(
    "options",
    "remoteControlWhitelistOnly",
    true,
  );
  setClientConfig("trusted", { remoteControl: "allow" });
  const f = await setup(false);
  const connect = (session: PeerSession) => {
    Object.defineProperty(
      session,
      "isMessageChannelReady",
      { get: () => true },
    );
    const messages: SessionMessage[] = [];
    vi.spyOn(session, "sendMessage").mockImplementation(
      async (message) => {
        messages.push(message);
      },
    );
    (
      session as unknown as Pick<
        MultiEventEmitter<PeerSessionEventMap>,
        "dispatchEvent"
      >
    ).dispatchEvent("messagechannelchange", "ready");
    return messages;
  };
  try {
    const stranger = connect(f.session);
    const trusted = connect(
      await f.service.addClient({
        clientId: "trusted",
        createdAt: 3,
        name: "Trusted",
        avatar: null,
      }),
    );
    await flush();
    expect(stranger[0]).toMatchObject({
      type: "peer-capabilities",
      update: { kind: "snapshot" },
    });
    const first = stranger[0] as any;
    expect(first.update.services).not.toHaveProperty(
      "control/1",
    );
    expect(first.update.services).toHaveProperty(
      "screen/1",
    );
    expect(first.update.services).toHaveProperty(
      "messaging/1",
    );
    expect(
      (trusted[0] as any).update.services,
    ).toHaveProperty("control/1");
    const request = vi.spyOn(
      f.service.remoteControl,
      "requestScreen",
    );
    f.channel.receive({
      type: "control-request",
      id: "hidden-request",
    });
    await flush();
    expect(request).not.toHaveBeenCalled();
    expect(
      f.channel.sent.some(
        (message) => message.type === "control-result",
      ),
    ).toBe(false);
    const trustedCount = trusted.length;
    const change = async (
      action: () => void,
      exposed: boolean,
    ) => {
      const before = stranger.length;
      action();
      await flush();
      expect(stranger.length).toBe(before + 1);
      const update = (stranger.at(-1) as any).update;
      expect(update.kind).toBe("patch");
      expect(Object.keys(update.services)).toEqual([
        "control/1",
      ]);
      if (exposed)
        expect(update.services["control/1"]).toMatchObject({
          host: true,
        });
      else expect(update.services["control/1"]).toBeNull();
      expect(trusted).toHaveLength(trustedCount);
      expect(
        f.channel.sent
          .filter((value) => value.type === "offer")
          .at(-1)?.control,
      ).toBe(exposed ? true : undefined);
    };
    await change(
      () =>
        setClientConfig("remote", {
          remoteControl: "allow",
        }),
      true,
    );
    await change(
      () =>
        setClientConfig("remote", {
          remoteControl: "deny",
        }),
      false,
    );
    await change(
      () =>
        setClientConfig("remote", {
          remoteControl: "allow",
        }),
      true,
    );
    await change(
      () =>
        setClientConfig("remote", {
          remoteControl: undefined,
        }),
      false,
    );
    await change(
      () =>
        setAppState(
          "options",
          "remoteControlWhitelistOnly",
          false,
        ),
      true,
    );
    await change(
      () =>
        setAppState(
          "options",
          "remoteControlWhitelistOnly",
          true,
        ),
      false,
    );
    expect(
      stranger.every(
        (message) =>
          !JSON.stringify(message).includes("whitelist"),
      ),
    ).toBe(true);
  } finally {
    f.close();
  }
});

it("withdraws an unanswered request silently when whitelist mode is enabled", async () => {
  const f = await setup();
  try {
    f.service.remoteControl.screen.share = vi.fn(
      async () => "screen",
    );
    f.channel.receive({
      type: "control-request",
      id: "before-policy-change",
    });
    await flush();
    expect(
      f.service.remoteControl.status().pending,
    ).toHaveLength(1);
    setAppState(
      "options",
      "remoteControlWhitelistOnly",
      true,
    );
    await flush();
    expect(
      f.service.remoteControl.status().pending,
    ).toEqual([]);
    expect(
      f.channel.sent.some(
        (message) => message.type === "control-result",
      ),
    ).toBe(false);
    expect(
      f.service.remoteControl.screen.share,
    ).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
