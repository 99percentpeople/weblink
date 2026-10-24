import { afterEach, expect, it, vi } from "vitest";
import { DiagnosticPeerPermissions } from "@/libs/application/automation/diagnostic-permissions";
import type {
  ToolCall,
  Principal,
} from "@weblink/automation";

const principal: Principal = {
  id: "peer",
  label: "Peer",
  kind: "peer",
  generation: "connection-1",
};
const call: ToolCall = {
  name: "diagnostics.snapshot",
  arguments: { target: "local" },
};
const fixture = () => {
  const permissions = new DiagnosticPeerPermissions(
    vi.fn(),
  );
  const key = {};
  permissions.update(key, principal, "ask");
  const signal = new AbortController().signal;
  return { permissions, key, signal };
};
afterEach(() => vi.useRealTimers());

it("shares session approval across concurrent diagnostic reads and forgets it on disconnect", async () => {
  const { permissions, key, signal } = fixture();
  const first = permissions.authorize(key, call, signal);
  const second = permissions.authorize(key, call, signal);
  expect(permissions.approvals()).toHaveLength(2);
  permissions.decide(permissions.approvals()[0].id, true);
  const checks = await Promise.all([first, second]);
  checks.forEach((check) => check());
  expect(permissions.approvals()).toEqual([]);
  await permissions.authorize(key, call, signal);
  permissions.disconnect(key);
  checks.forEach((check) =>
    expect(check).toThrow("TARGET_DISCONNECTED"),
  );
  const replacement = {};
  permissions.update(
    replacement,
    { ...principal, generation: "connection-2" },
    "ask",
  );
  const next = permissions.authorize(
    replacement,
    call,
    signal,
  );
  permissions.decide(permissions.approvals()[0].id, false);
  await expect(next).rejects.toThrow("PERMISSION_DENIED");
});

it("enforces saved deny and revokes in-flight consent when policy changes", async () => {
  const { permissions, key, signal } = fixture();
  permissions.update(key, principal, "allow");
  const check = await permissions.authorize(
    key,
    call,
    signal,
  );
  permissions.update(key, principal, "deny");
  expect(check).toThrow("PERMISSION_DENIED");
  await expect(
    permissions.authorize(key, call, signal),
  ).rejects.toThrow("PERMISSION_DENIED");
  permissions.update(key, principal, "ask");
  const pending = permissions.authorize(key, call, signal);
  const id = permissions.approvals()[0].id;
  permissions.update(key, principal, "allow");
  await pending;
  expect(() => permissions.decide(id, true)).toThrow(
    "REQUEST_EXPIRED",
  );
  permissions.update(key, principal, "ask");
  expect(check).toThrow("PERMISSION_DENIED");
  permissions.update(key, principal, "allow");
  expect(check).toThrow("PERMISSION_DENIED");
});

it("does not approve a different connection with the same device ID", async () => {
  const { permissions, key, signal } = fixture();
  const other = {};
  permissions.update(
    other,
    { ...principal, generation: "connection-2" },
    "ask",
  );
  const first = permissions.authorize(key, call, signal);
  const second = permissions.authorize(other, call, signal);
  permissions.decide(permissions.approvals()[0].id, true);
  await first;
  expect(permissions.approvals()).toHaveLength(1);
  permissions.disconnect(other);
  await expect(second).rejects.toThrow(
    "TARGET_DISCONNECTED",
  );
});

it("cleans up cancelled, timed out and excessive reviews", async () => {
  vi.useFakeTimers();
  const { permissions, key } = fixture();
  const controllers = Array.from(
    { length: 8 },
    () => new AbortController(),
  );
  const pending = controllers.map((controller) =>
    permissions
      .authorize(key, call, controller.signal)
      .catch((error: Error) => error.message),
  );
  await expect(
    permissions.authorize(
      key,
      call,
      new AbortController().signal,
    ),
  ).rejects.toThrow("BUSY");
  controllers[0].abort();
  expect(await pending[0]).toBe("CANCELLED");
  await vi.advanceTimersByTimeAsync(120000);
  expect(await Promise.all(pending.slice(1))).toEqual(
    Array(7).fill("TIMEOUT"),
  );
  expect(permissions.approvals()).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});
