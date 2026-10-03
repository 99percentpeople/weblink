import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { reconcile } from "solid-js/store";
import type { NativeControlStatus } from "@weblink/platform";
import type { ClientService } from "@/libs/domain/client";
import type { PeerSession } from "@/libs/domain/session";
import {
  NativeScreenSession,
  type NativeScreenPublication,
} from "@/libs/domain/native-screen/session";
import { SessionService } from "@/libs/application/session-service";
import {
  createInitialAppState,
  setAppState,
} from "@/libs/state/app-state";
import { setClientConfig } from "@/libs/state/permission-options";

const api = vi.hoisted(() => ({
  open: vi.fn<() => Promise<string>>(),
  end: vi.fn(async () => {}),
  status: vi.fn<() => Promise<NativeControlStatus>>(),
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
    pending: null,
    clientId: null,
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function setup() {
  const service = new SessionService({
    loadIceServers: async () => [],
  });
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
  channel.receive({
    type: "hello",
    receiveScreen: true,
    remoteControl: { request: true, host: false },
  });
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
  expect(offer.control).toBe(true);
  channel.receive({
    type: "answer",
    id: offer.id,
    sdp: "answer",
  });
  await flush();
  return {
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
      pending: {
        consentId: "consent",
        clientId: "remote",
        sourceId: "screen",
      },
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
    api.status.mockResolvedValueOnce({
      closed: true,
      clientId: null,
      pending: null,
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
