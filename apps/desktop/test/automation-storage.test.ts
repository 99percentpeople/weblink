import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { nativeAutomation } from "../src/automation";
import {
  createAutomationStorage,
  MCP_STORAGE_KEY,
} from "../src/automation-storage";

const empty = () => ({
  version: 1,
  host: "127.0.0.1",
  port: 32100,
  clients: {} as Record<string, unknown>,
});
const token = "sk-secret-shown-once";
const client = {
  id: "client",
  label: "Agent",
  tokenHash: "a".repeat(64),
  prefix: "sk-secret",
  createdAt: 1,
  expiresAt: null,
  lastUsedAt: null,
};
const stored = () => ({ ...empty(), clients: { client } });

describe("MCP localStorage persistence", () => {
  let epoch: string;
  let active = empty();
  let revision = 0;
  const ipc = vi.fn();
  const receive = vi.fn();
  beforeEach(async () => {
    localStorage.clear();
    revision = 0;
    ipc.mockReset();
    receive.mockReset();
    ipc.mockImplementation(
      async (command: string, args: any) => {
        if (command === "automation_open") {
          active = structuredClone(
            args.registry ?? empty(),
          );
          return { epoch: "page", registry: active };
        }
        if (command === "automation_registry_apply") {
          // At the native activation boundary persistence must already be complete.
          expect(
            JSON.parse(
              localStorage.getItem(MCP_STORAGE_KEY)!,
            ),
          ).toEqual(args.registry);
          active = structuredClone(args.registry);
          revision++;
          return;
        }
        if (command === "automation_close") return;
        if (command === "automation_snapshot")
          return args.includeClients === false
            ? {}
            : {
                clients: structuredClone(
                  Object.values(active.clients),
                ),
              };
        let registry = structuredClone(active);
        let result: unknown = null;
        if (command === "automation_client") {
          registry.clients.client = client;
          result = {
            id: "client",
            token,
            endpoint: "http://127.0.0.1:32100/mcp",
          };
        } else if (command === "automation_client_update") {
          registry.clients[args.id] = {
            ...(registry.clients[args.id] as typeof client),
            label: args.label,
            expiresAt: args.expiresAt,
          };
        } else if (command === "automation_client_remove") {
          delete registry.clients[args.id];
        } else if (
          command === "automation_server_configure"
        ) {
          registry = { ...registry, ...args.config };
        } else
          throw new Error(`Unexpected command: ${command}`);
        return { registry, revision, result };
      },
    );
    mockIPC(ipc);
    epoch = await nativeAutomation.open(receive);
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await nativeAutomation.close(epoch).catch(() => {});
    clearMocks();
  });
  const eventChannel = () =>
    ipc.mock.calls
      .filter(([name]) => name === "automation_open")
      .at(-1)![1].channel;
  const used = (at: number) => {
    const record = active.clients.client as {
      lastUsedAt: number | null;
    };
    record.lastUsedAt = Math.max(
      record.lastUsedAt ?? 0,
      at,
    );
    eventChannel().onmessage({
      kind: "token-used",
      epoch,
      id: "client",
      lastUsedAt: at,
    });
  };
  const saved = () =>
    JSON.parse(localStorage.getItem(MCP_STORAGE_KEY)!);

  it("persists usage events immediately and restores the time after reopening", async () => {
    await nativeAutomation.client(epoch, "Agent", null);
    used(1000);
    expect(saved().clients.client.lastUsedAt).toBe(1000);
    expect(receive).toHaveBeenLastCalledWith({
      kind: "token-used",
      epoch,
      id: "client",
      lastUsedAt: 1000,
    });
    expect(
      ipc.mock.calls.some(
        ([name]) => name === "automation_snapshot",
      ),
    ).toBe(false);
    used(900);
    expect(saved().clients.client.lastUsedAt).toBe(1000);
    await nativeAutomation.close(epoch);
    epoch = await nativeAutomation.open(() => {});
    expect(active.clients.client).toMatchObject({
      lastUsedAt: 1000,
    });
  });

  it("merges a newer usage event into an edit prepared before that event", async () => {
    await nativeAutomation.client(epoch, "Agent", null);
    const handler = ipc.getMockImplementation()!;
    let release!: () => void;
    ipc.mockImplementation(
      async (name: string, args: any) => {
        const result = await handler(name, args);
        if (name === "automation_client_update")
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return result;
      },
    );
    const update = nativeAutomation.updateClient(
      epoch,
      "client",
      "Renamed",
      null,
    );
    await vi.waitFor(() =>
      expect(release).toBeTypeOf("function"),
    );
    used(2000);
    release();
    await update;
    expect(saved().clients.client).toMatchObject({
      label: "Renamed",
      lastUsedAt: 2000,
    });
    expect(active.clients.client).toMatchObject({
      label: "Renamed",
      lastUsedAt: 2000,
    });
  });

  it("keeps usage received while activation IPC is in flight", async () => {
    await nativeAutomation.client(epoch, "Agent", null);
    const handler = ipc.getMockImplementation()!;
    let release!: () => void;
    ipc.mockImplementation(
      async (name: string, args: any) => {
        const result = await handler(name, args);
        if (name === "automation_registry_apply")
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return result;
      },
    );
    const update = nativeAutomation.updateClient(
      epoch,
      "client",
      "Renamed",
      null,
    );
    await vi.waitFor(() =>
      expect(release).toBeTypeOf("function"),
    );
    used(3000);
    release();
    await update;
    expect(saved().clients.client).toMatchObject({
      label: "Renamed",
      lastUsedAt: 3000,
    });
  });

  it("retries failed metadata writes on notifications without querying native state", async () => {
    await nativeAutomation.client(epoch, "Agent", null);
    const write = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementationOnce(() => {
        throw new DOMException(
          "full",
          "QuotaExceededError",
        );
      });
    expect(() => used(4000)).not.toThrow();
    expect(saved().clients.client.lastUsedAt).toBeNull();
    used(4000);
    expect(saved().clients.client.lastUsedAt).toBe(4000);
    used(5000);
    expect(saved().clients.client.lastUsedAt).toBe(5000);
    expect(
      ipc.mock.calls.some(
        ([name]) => name === "automation_snapshot",
      ),
    ).toBe(false);
    write.mockRestore();
  });

  it("does not persist or forward usage for a revoked token", async () => {
    await nativeAutomation.client(epoch, "Agent", null);
    used(1000);
    await nativeAutomation.removeClient(epoch, "client");
    receive.mockClear();
    eventChannel().onmessage({
      kind: "token-used",
      epoch,
      id: "client",
      lastUsedAt: 6000,
    });
    expect(saved().clients).toEqual({});
    expect(receive).not.toHaveBeenCalled();
  });

  it("ignores usage notifications from an old or closed page", async () => {
    await nativeAutomation.client(epoch, "Agent", null);
    used(7000);
    receive.mockClear();
    eventChannel().onmessage({
      kind: "token-used",
      epoch: "old-page",
      id: "client",
      lastUsedAt: 8000,
    });
    expect(saved().clients.client.lastUsedAt).toBe(7000);
    await nativeAutomation.close(epoch);
    used(9000);
    expect(saved().clients.client.lastUsedAt).toBe(7000);
    expect(receive).not.toHaveBeenCalled();
  });

  it("omits tokens from periodic status queries without persisting a snapshot", async () => {
    await nativeAutomation.client(epoch, "Agent", null);
    const write = vi.spyOn(Storage.prototype, "setItem");
    expect(
      await nativeAutomation.snapshot(epoch, false),
    ).toEqual({});
    expect(ipc).toHaveBeenLastCalledWith(
      "automation_snapshot",
      { epoch, includeClients: false },
    );
    expect(write).not.toHaveBeenCalled();
  });
  it("stores only hashes and restores tokens and listener settings on the next open", async () => {
    expect(
      (await nativeAutomation.client(epoch, "Agent", null))
        .token,
    ).toBe(token);
    await nativeAutomation.configureServer(epoch, {
      host: "::1",
      port: 32101,
    });
    const saved = localStorage.getItem(MCP_STORAGE_KEY)!;
    expect(saved).not.toContain(token);
    expect(JSON.parse(saved)).toEqual({
      ...stored(),
      host: "::1",
      port: 32101,
    });
    await nativeAutomation.close(epoch);
    epoch = await nativeAutomation.open(() => {});
    expect(active).toEqual(JSON.parse(saved));
    expect(
      ipc.mock.calls
        .filter(([name]) => name === "automation_open")
        .at(-1)?.[1].registry,
    ).toEqual(active);
  });
  it("serializes concurrent settings and token edits without losing a change", async () => {
    await Promise.all([
      nativeAutomation.client(epoch, "Agent", null),
      nativeAutomation.configureServer(epoch, {
        host: "0.0.0.0",
        port: 4321,
      }),
      nativeAutomation.updateClient(
        epoch,
        "client",
        "Renamed",
        123456789,
      ),
    ]);
    expect(active).toEqual({
      ...stored(),
      host: "0.0.0.0",
      port: 4321,
      clients: {
        client: {
          ...client,
          label: "Renamed",
          expiresAt: 123456789,
        },
      },
    });
    expect(
      ipc.mock.calls
        .filter(
          ([name]) => name === "automation_registry_apply",
        )
        .map(([, args]) => args.revision),
    ).toEqual([0, 1, 2]);
  });
  it("keeps revocation after reopening and leaves an empty store empty", async () => {
    await nativeAutomation.client(epoch, "Agent", null);
    await nativeAutomation.removeClient(epoch, "client");
    await nativeAutomation.close(epoch);
    epoch = await nativeAutomation.open(() => {});
    expect(active.clients).toEqual({});
    await nativeAutomation.close(epoch);
    localStorage.clear();
    epoch = await nativeAutomation.open(() => {});
    expect(active).toEqual(empty());
  });
  it("does not activate a token when localStorage rejects the write", async () => {
    const before = localStorage.getItem(MCP_STORAGE_KEY);
    vi.spyOn(
      Storage.prototype,
      "setItem",
    ).mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    await expect(
      nativeAutomation.client(epoch, "Agent", null),
    ).rejects.toMatchObject({
      code: "AUTOMATION_STORAGE_UNAVAILABLE",
    });
    expect(active.clients).toEqual({});
    expect(localStorage.getItem(MCP_STORAGE_KEY)).toBe(
      before,
    );
    expect(
      ipc.mock.calls.some(
        ([name]) => name === "automation_registry_apply",
      ),
    ).toBe(false);
  });
  it("closes a newly opened native session if initial persistence fails", async () => {
    await nativeAutomation.close(epoch);
    vi.spyOn(
      Storage.prototype,
      "setItem",
    ).mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    await expect(
      nativeAutomation.open(() => {}),
    ).rejects.toMatchObject({
      code: "AUTOMATION_STORAGE_UNAVAILABLE",
    });
    expect(ipc).toHaveBeenLastCalledWith(
      "automation_close",
      { epoch: "page" },
    );
    await expect(
      nativeAutomation.client("page", "Agent", null),
    ).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  });
  it("does not open native authority when localStorage cannot be read", async () => {
    await nativeAutomation.close(epoch);
    ipc.mockClear();
    vi.spyOn(
      Storage.prototype,
      "getItem",
    ).mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    await expect(
      nativeAutomation.open(() => {}),
    ).rejects.toMatchObject({
      code: "AUTOMATION_STORAGE_UNAVAILABLE",
    });
    expect(ipc).not.toHaveBeenCalled();
  });
  it("keeps saved revocation and closes the session if activation IPC fails", async () => {
    await nativeAutomation.client(epoch, "Agent", null);
    const handler = ipc.getMockImplementation()!;
    ipc.mockImplementation(
      async (name: string, args: any) => {
        if (name === "automation_registry_apply")
          throw "SESSION_CLOSED";
        return handler(name, args);
      },
    );
    await expect(
      nativeAutomation.removeClient(epoch, "client"),
    ).rejects.toMatchObject({ code: "SESSION_CLOSED" });
    expect(
      JSON.parse(localStorage.getItem(MCP_STORAGE_KEY)!)
        .clients,
    ).toEqual({});
    expect(ipc).toHaveBeenLastCalledWith(
      "automation_close",
      { epoch },
    );
    await expect(
      nativeAutomation.client(epoch, "Later", null),
    ).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  });
  it("rejects corrupt storage without overwriting it or opening native authority", async () => {
    await nativeAutomation.close(epoch);
    for (const invalid of ["{", "null", "[]", '"text"']) {
      localStorage.setItem(MCP_STORAGE_KEY, invalid);
      ipc.mockClear();
      await expect(
        nativeAutomation.open(() => {}),
      ).rejects.toMatchObject({
        code: "INVALID_AUTOMATION_REGISTRY",
      });
      expect(localStorage.getItem(MCP_STORAGE_KEY)).toBe(
        invalid,
      );
      expect(ipc).not.toHaveBeenCalled();
    }
  });
  it("does not persist a late prepared change after its page closes", async () => {
    let resolve!: (value: unknown) => void;
    const handler = ipc.getMockImplementation()!;
    ipc.mockImplementation((name: string, args: any) =>
      name === "automation_client"
        ? new Promise((done) => {
            resolve = done;
          })
        : handler(name, args),
    );
    const pending = nativeAutomation.client(
      epoch,
      "Agent",
      null,
    );
    const result = expect(pending).rejects.toMatchObject({
      code: "SESSION_CLOSED",
    });
    await vi.waitFor(() =>
      expect(resolve).toBeTypeOf("function"),
    );
    await nativeAutomation.close(epoch);
    resolve({
      revision: 0,
      registry: stored(),
      result: { id: "client", token },
    });
    await result;
    expect(
      JSON.parse(localStorage.getItem(MCP_STORAGE_KEY)!),
    ).toEqual(empty());
    expect(
      ipc.mock.calls.some(
        ([name]) => name === "automation_registry_apply",
      ),
    ).toBe(false);
  });
  it("keeps independent WebView stores isolated", async () => {
    const dev = new Map<string, string>();
    const stable = new Map([
      [MCP_STORAGE_KEY, JSON.stringify(stored())],
    ]);
    const open = async (values: Map<string, string>) => {
      const native = vi.fn(
        async (_: string, args: any) => ({
          epoch: "isolated",
          registry: args.registry ?? empty(),
        }),
      );
      const adapter = createAutomationStorage(
        native as any,
        () => ({
          getItem: (key) => values.get(key) ?? null,
          setItem: (key, value) => {
            values.set(key, value);
          },
        }),
      );
      await adapter.open({});
      return native.mock.calls[0][1].registry;
    };
    expect(await open(dev)).toBeNull();
    expect(await open(stable)).toEqual(stored());
    expect(JSON.parse(dev.get(MCP_STORAGE_KEY)!)).toEqual(
      empty(),
    );
    expect(
      JSON.parse(stable.get(MCP_STORAGE_KEY)!),
    ).toEqual(stored());
  });
});
