import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type {
  ClientService,
  ClientServiceInitOptions,
  TransferClient,
} from "@/libs/domain/client";
import type { PeerSession } from "@/libs/domain/session";
import { RoomService } from "@/libs/application/room-service";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";

function createClientService(): ClientService {
  const info: TransferClient = {
    clientId: "local",
    name: "Local",
    avatar: null,
    createdAt: 1,
  };

  return {
    info,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createSender: vi.fn(),
    removeSender: vi.fn(),
    listenForJoin: vi.fn(),
    listenForLeave: vi.fn(),
    createClient: vi.fn(async () => {}),
    updateClient: vi.fn(async () => {}),
    close: vi.fn(),
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

const rooms: RoomService[] = [];
afterEach(() => {
  for (const room of rooms.splice(0)) room.dispose();
  vi.useRealTimers();
});

function createHarness(
  createService: (
    options: ClientServiceInitOptions,
  ) => Promise<ClientService>,
) {
  let installed: ClientService | undefined;
  const sessions = {
    sessions: {} as Record<string, PeerSession>,
    get clientService() {
      return installed;
    },
    setClientService: vi.fn((service: ClientService) => {
      installed = service;
    }),
    removeService: vi.fn(() => {
      installed?.close();
      installed = undefined;
    }),
    addClient: vi.fn(),
    removeSession: vi.fn(),
    destoryAllSession: vi.fn(() => {
      installed?.close();
      installed = undefined;
    }),
  };
  const rtc = {
    bindSession: vi.fn(),
    unbindSession: vi.fn(),
    unbindAllSessions: vi.fn(),
  };
  const profiles = {
    bindSession: vi.fn(),
    unbindSession: vi.fn(),
    unbindAllSessions: vi.fn(),
  };
  const messages = {
    setClient: vi.fn(),
  };
  const onLeaving = vi.fn();
  const onMemberJoined = vi.fn();
  const room = new RoomService({
    sessions,
    rtc,
    profiles,
    messages,
    createClientService: createService,
    getLocalStream: () => null,
    onLeaving,
    onMemberJoined,
  });
  rooms.push(room);

  return {
    room,
    sessions,
    rtc,
    profiles,
    messages,
    onLeaving,
    onMemberJoined,
  };
}

beforeEach(() => {
  setAppState("profile", {
    roomId: "room-a",
    password: null,
    autoJoin: false,
    initalJoin: false,
    clientId: "local",
    name: "Local",
    avatar: null,
  });
  setAppState("roomStatus", {
    roomId: null,
    profile: null,
    joinedAt: null,
  });
});

describe("RoomService", () => {
  it("keeps room signaling alive when an interrupted peer attempt fails", async () => {
    const service = createClientService();
    const h = createHarness(async () => service);
    await h.room.join();
    const failure = deferred<void>();
    const session = {
      polite: false,
      setStream: vi.fn(),
      listen: vi.fn(async () => {}),
      connect: vi.fn(() => failure.promise),
      close: vi.fn(),
    } as unknown as PeerSession;
    h.sessions.addClient.mockResolvedValue(session);
    const joined = vi.mocked(service.listenForJoin).mock
      .calls[0][0];
    joined({
      clientId: "remote",
      createdAt: 2,
      name: "Remote",
      avatar: null,
    });
    await vi.waitFor(() =>
      expect(session.connect).toHaveBeenCalled(),
    );
    failure.reject(new Error("signaling disconnected"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(service.close).not.toHaveBeenCalled();
    expect(appState.roomStatus.roomId).toBe("room-a");
  });

  it("starts the room clock after a successful join and resets it only after leaving", async () => {
    vi.useFakeTimers();
    const service = createClientService();
    const pending = deferred<void>();
    vi.mocked(service.createClient).mockReturnValueOnce(
      pending.promise,
    );
    const harness = createHarness(async () => service);
    vi.setSystemTime(10_000);
    const joining = harness.room.join();
    await Promise.resolve();
    expect(appState.roomStatus.joinedAt).toBeNull();
    vi.setSystemTime(12_000);
    pending.resolve();
    await joining;
    expect(appState.roomStatus.joinedAt).toBe(12_000);

    vi.setSystemTime(20_000);
    await harness.room.join();
    expect(appState.roomStatus.joinedAt).toBe(12_000);
    harness.room.leave();
    expect(appState.roomStatus.joinedAt).toBeNull();

    await harness.room.join();
    expect(appState.roomStatus.joinedAt).toBe(20_000);
    setAppState("profile", "roomId", "room-b");
    vi.setSystemTime(30_000);
    await harness.room.join();
    expect(appState.roomStatus.joinedAt).toBe(30_000);
  });

  it("records silent members against the joined room and ignores joins finishing after departure", async () => {
    const service = createClientService();
    const harness = createHarness(async () => service);
    await harness.room.join();
    const joined = vi.mocked(service.listenForJoin).mock
      .calls[0][0];
    const peer = {
      clientId: "peer",
      name: "Peer",
      avatar: null,
      createdAt: 2,
    };
    const session = {
      setStream: vi.fn(),
      listen: vi.fn(async () => {}),
      close: vi.fn(),
      polite: true,
    } as unknown as PeerSession;
    harness.sessions.addClient.mockResolvedValueOnce(
      session,
    );
    // Editing the next room name does not change the scope of the active service.
    setAppState("profile", "roomId", "room-b");
    joined(peer);
    await vi.waitFor(() =>
      expect(harness.onMemberJoined).toHaveBeenCalledWith(
        "room-a",
        peer,
      ),
    );
    expect(harness.messages.setClient).toHaveBeenCalledWith(
      peer,
    );

    const pending = deferred<PeerSession>();
    harness.sessions.addClient.mockReturnValueOnce(
      pending.promise,
    );
    joined({ ...peer, clientId: "late" });
    harness.room.leave();
    pending.resolve(session);
    await vi.waitFor(() =>
      expect(session.close).toHaveBeenCalled(),
    );
    expect(harness.onMemberJoined).toHaveBeenCalledTimes(1);
  });

  it("owns client service installation and room status", async () => {
    const clientService = createClientService();
    const harness = createHarness(
      async () => clientService,
    );

    await harness.room.join();

    expect(
      harness.sessions.setClientService,
    ).toHaveBeenCalledWith(clientService);
    expect(
      clientService.listenForJoin,
    ).toHaveBeenCalledTimes(1);
    expect(
      clientService.listenForLeave,
    ).toHaveBeenCalledTimes(1);
    expect(
      clientService.createClient,
    ).toHaveBeenCalledTimes(1);
    expect(appState.roomStatus.roomId).toBe("room-a");
    expect(appState.roomStatus.profile?.clientId).toBe(
      "local",
    );

    harness.room.leave();

    expect(harness.onLeaving).toHaveBeenCalledTimes(1);
    expect(
      harness.profiles.unbindAllSessions,
    ).toHaveBeenCalledTimes(1);
    expect(
      harness.rtc.unbindAllSessions,
    ).toHaveBeenCalledTimes(1);
    expect(
      harness.sessions.destoryAllSession,
    ).toHaveBeenCalledTimes(1);
    expect(appState.roomStatus.roomId).toBeNull();
  });

  it.each(["old-first", "new-first"])(
    "switches rooms during client creation (%s)",
    async (order) => {
      const pendingA = deferred<ClientService>();
      const pendingB = deferred<ClientService>();
      const serviceA = createClientService();
      const serviceB = createClientService();
      const factory = vi.fn(
        (options: ClientServiceInitOptions) =>
          options.roomId === "room-a"
            ? pendingA.promise
            : pendingB.promise,
      );
      const harness = createHarness(factory);
      const joiningA = harness.room
        .join()
        .catch((error) => error);

      setAppState("profile", "roomId", "room-b");
      const joiningB = harness.room.join();
      expect(
        factory.mock.calls.map(
          ([options]) => options.roomId,
        ),
      ).toEqual(["room-a", "room-b"]);

      if (order === "old-first") {
        pendingA.resolve(serviceA);
        expect(await joiningA).toMatchObject({
          name: "AbortError",
        });
        expect(appState.roomStatus.roomId).toBeNull();
        pendingB.resolve(serviceB);
        await joiningB;
      } else {
        pendingB.resolve(serviceB);
        await joiningB;
        pendingA.resolve(serviceA);
        expect(await joiningA).toMatchObject({
          name: "AbortError",
        });
      }

      expect(harness.sessions.clientService).toBe(serviceB);
      expect(appState.roomStatus.roomId).toBe("room-b");
      expect(serviceA.close).toHaveBeenCalledTimes(1);
      expect(serviceA.createClient).not.toHaveBeenCalled();
      expect(serviceB.close).not.toHaveBeenCalled();
    },
  );

  it("shares the entire join operation for the same room", async () => {
    const pending = deferred<ClientService>();
    const handshake = deferred<void>();
    const service = createClientService();
    vi.mocked(service.createClient).mockReturnValue(
      handshake.promise,
    );
    const factory = vi.fn(() => pending.promise);
    const { room } = createHarness(factory);

    const first = room.join();
    const second = room.join();
    expect(first).toBe(second);
    pending.resolve(service);
    await vi.waitFor(() =>
      expect(service.createClient).toHaveBeenCalledTimes(1),
    );
    const third = room.join();
    expect(third).toBe(first);
    handshake.resolve();
    await Promise.all([first, second, third]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(service.createClient).toHaveBeenCalledTimes(1);
    expect(service.listenForJoin).toHaveBeenCalledTimes(1);
    expect(appState.roomStatus.roomId).toBe("room-a");
  });

  it.each(["resolve", "reject"])(
    "does not let a retired handshake %s affect the new room",
    async (outcome) => {
      const handshake = deferred<void>();
      const serviceA = createClientService();
      const serviceB = createClientService();
      vi.mocked(serviceA.createClient).mockReturnValue(
        handshake.promise,
      );
      const harness = createHarness(async (options) =>
        options.roomId === "room-a" ? serviceA : serviceB,
      );
      const joiningA = harness.room
        .join()
        .catch((error) => error);
      await vi.waitFor(() =>
        expect(serviceA.createClient).toHaveBeenCalledTimes(
          1,
        ),
      );

      setAppState("profile", "roomId", "room-b");
      await harness.room.join();
      if (outcome === "resolve") handshake.resolve();
      else
        handshake.reject(
          new Error("retired handshake failed"),
        );
      expect(await joiningA).toMatchObject({
        name: "AbortError",
      });

      expect(appState.roomStatus.roomId).toBe("room-b");
      expect(harness.sessions.clientService).toBe(serviceB);
      expect(serviceA.close).toHaveBeenCalledTimes(1);
      expect(serviceB.close).not.toHaveBeenCalled();
    },
  );

  it.each(["password", "clientId"] as const)(
    "replaces a pending join when %s changes in the same room",
    async (field) => {
      const pending = deferred<ClientService>();
      const staleService = createClientService();
      const currentService = createClientService();
      const factory = vi
        .fn<
          (
            options: ClientServiceInitOptions,
          ) => Promise<ClientService>
        >()
        .mockReturnValueOnce(pending.promise)
        .mockResolvedValueOnce(currentService);
      const harness = createHarness(factory);
      const stale = harness.room
        .join()
        .catch((error) => error);

      setAppState("profile", field, "changed");
      await harness.room.join();
      pending.resolve(staleService);
      expect(await stale).toMatchObject({
        name: "AbortError",
      });
      expect(factory).toHaveBeenCalledTimes(2);
      expect(harness.sessions.clientService).toBe(
        currentService,
      );
      expect(staleService.close).toHaveBeenCalledTimes(1);
      expect(currentService.close).not.toHaveBeenCalled();
    },
  );

  it("keeps a new join owned after leaving and rejoining the same room", async () => {
    const oldPending = deferred<ClientService>();
    const newPending = deferred<ClientService>();
    const oldService = createClientService();
    const newService = createClientService();
    const factory = vi
      .fn()
      .mockReturnValueOnce(oldPending.promise)
      .mockReturnValueOnce(newPending.promise);
    const harness = createHarness(factory);
    const stale = harness.room
      .join()
      .catch((error) => error);
    harness.room.leave();
    const current = harness.room.join();

    oldPending.resolve(oldService);
    expect(await stale).toMatchObject({
      name: "AbortError",
    });
    const repeated = harness.room.join();
    expect(repeated).toBe(current);
    expect(factory).toHaveBeenCalledTimes(2);
    newPending.resolve(newService);
    await current;
    expect(appState.roomStatus.roomId).toBe("room-a");
    expect(harness.sessions.clientService).toBe(newService);
  });

  it.each(["factory", "handshake"])(
    "allows retry after a %s failure",
    async (stage) => {
      const error = new Error("join failed");
      const failedService = createClientService();
      const retryService = createClientService();
      vi.mocked(
        failedService.createClient,
      ).mockRejectedValue(error);
      const factory =
        vi.fn<
          (
            options: ClientServiceInitOptions,
          ) => Promise<ClientService>
        >();
      if (stage === "factory")
        factory.mockRejectedValueOnce(error);
      else factory.mockResolvedValueOnce(failedService);
      factory.mockResolvedValueOnce(retryService);
      const harness = createHarness(factory);

      await expect(harness.room.join()).rejects.toBe(error);
      expect(appState.roomStatus.roomId).toBeNull();
      expect(
        harness.sessions.clientService,
      ).toBeUndefined();
      await harness.room.join();
      expect(harness.sessions.clientService).toBe(
        retryService,
      );
      expect(appState.roomStatus.roomId).toBe("room-a");
    },
  );

  it("closes a late client after disposal and rejects future joins", async () => {
    const pending = deferred<ClientService>();
    const service = createClientService();
    const factory = vi.fn(() => pending.promise);
    const harness = createHarness(factory);
    const stale = harness.room
      .join()
      .catch((error) => error);
    harness.room.dispose();
    pending.resolve(service);
    expect(await stale).toMatchObject({
      name: "AbortError",
    });
    await expect(harness.room.join()).rejects.toMatchObject(
      { name: "AbortError" },
    );
    expect(factory).toHaveBeenCalledTimes(1);
    expect(service.close).toHaveBeenCalledTimes(1);
    expect(appState.roomStatus.roomId).toBeNull();
  });

  it("discards a client service that resolves after leaving", async () => {
    let resolveService!: (service: ClientService) => void;
    const pendingService = new Promise<ClientService>(
      (resolve) => {
        resolveService = resolve;
      },
    );
    const harness = createHarness(() => pendingService);
    const clientService = createClientService();

    const joining = harness.room.join();
    harness.room.leave();
    resolveService(clientService);

    await expect(joining).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(clientService.close).toHaveBeenCalledTimes(1);
    expect(
      harness.sessions.setClientService,
    ).not.toHaveBeenCalled();
    expect(appState.roomStatus.roomId).toBeNull();
  });
});
