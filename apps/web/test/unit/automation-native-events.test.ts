import { expect, it, vi } from "vitest";
import { NativeAutomationEvents } from "@/libs/application/automation/native-events";

it("buffers native notifications until activation and preserves topic order and epoch fencing", () => {
  const lifetime = new AbortController();
  const channel = new NativeAutomationEvents(
    lifetime.signal,
  );
  const received: string[] = [];
  channel.events.subscribe("status", (event) =>
    received.push(`status:${event.snapshot.revision}`),
  );
  channel.events.subscribe("token-used", (event) =>
    received.push(`used:${event.lastUsedAt}`),
  );
  channel.events.subscribe("cancel", (event) =>
    received.push(`cancel:${event.id}`),
  );
  channel.receive({
    kind: "status",
    epoch: "current",
    snapshot: { revision: 1 },
  });
  channel.receive({
    kind: "token-used",
    epoch: "old",
    id: "token",
    lastUsedAt: 1,
  });
  channel.receive({
    kind: "token-used",
    epoch: "current",
    id: "token",
    lastUsedAt: 2,
  });
  channel.receive({ kind: "cancel", id: "call" });
  expect(received).toEqual([]);
  channel.activate("current");
  expect(received).toEqual([
    "status:1",
    "used:2",
    "cancel:call",
  ]);
  lifetime.abort();
  channel.receive({ kind: "cancel", id: "late" });
  expect(received).toHaveLength(3);
});

it("closing while draining prevents subsequent queued events and a late activation", () => {
  const channel = new NativeAutomationEvents(
    new AbortController().signal,
  );
  const receive = vi.fn();
  channel.events.subscribe("closed", () =>
    channel.dispose(),
  );
  channel.events.subscribe("status", receive);
  channel.receive({ kind: "closed", epoch: "current" });
  channel.receive({
    kind: "status",
    epoch: "current",
    snapshot: { revision: 1 },
  });
  channel.activate("current");
  channel.activate("replacement");
  channel.receive({
    kind: "status",
    epoch: "replacement",
    snapshot: { revision: 2 },
  });
  expect(receive).not.toHaveBeenCalled();
});
