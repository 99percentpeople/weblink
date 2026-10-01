import { afterEach, expect, it, vi } from "vitest";
import { RemoteControlHost } from "@/libs/application/remote-control-host";
import type { PlatformRuntime } from "@weblink/platform";
afterEach(() => vi.useRealTimers());
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};
function setup() {
  let next = 0;
  const api = {
    open: vi.fn(async () => `owner-${++next}`),
    end: vi.fn(async () => {}),
    status: vi.fn(async () => ({
      pending: null,
      clientId: null,
      closed: false,
    })),
    approve: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
  };
  const platform = {
    remoteControl: api,
    getCapabilities: vi.fn(async () => ({
      remoteInput: true,
    })),
  } as unknown as PlatformRuntime;
  const host = new RemoteControlHost(platform);
  return { host, api };
}
it("starts a distinct room owner, maintains its lease, and closes it on leave", async () => {
  vi.useFakeTimers();
  const { host, api } = setup();
  host.start();
  await flush();
  expect(await host.context("peer", "client")).toEqual({
    ownerId: "owner-1",
    peerGeneration: "peer",
    clientId: "client",
  });
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.status).toHaveBeenCalledTimes(3);
  host.close();
  expect(api.end).toHaveBeenCalledWith("owner-1");
  await vi.advanceTimersByTimeAsync(2000);
  expect(api.status).toHaveBeenCalledTimes(3);
  host.start();
  await flush();
  expect(
    await host.context("peer", "client"),
  ).toMatchObject({ ownerId: "owner-2" });
  host.close();
});
it("late native open completion cannot carry permission into another room", async () => {
  const { host, api } = setup();
  let finish!: (id: string) => void;
  api.open.mockImplementationOnce(
    () => new Promise((r) => (finish = r)),
  );
  host.start();
  await flush();
  host.start();
  finish("old-owner");
  await flush();
  expect(api.end).toHaveBeenCalledWith("old-owner");
  expect(
    await host.context("peer", "client"),
  ).toMatchObject({ ownerId: "owner-1" });
  host.close();
});
it("a failed owner heartbeat closes host capability instead of silently reopening", async () => {
  vi.useFakeTimers();
  const { host, api } = setup();
  host.start();
  await flush();
  api.status.mockRejectedValueOnce(
    new Error("owner expired"),
  );
  await vi.advanceTimersByTimeAsync(500);
  expect(await host.capabilities()).toEqual({
    request: true,
    host: false,
  });
  expect(host.status().closed).toBe(true);
  expect(api.open).toHaveBeenCalledTimes(1);
  host.close();
});
