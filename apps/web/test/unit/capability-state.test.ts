import { expect, it } from "vitest";
import { CapabilityState } from "@/libs/domain/protocol/capability-state";
import {
  changedCapabilities,
  type CapabilityChanges,
  type CapabilitySnapshot,
  type CapabilityAnnouncement,
  type PeerCapabilities,
} from "@/libs/domain/protocol/capabilities";

const snapshot = (
  revision: number,
  services: PeerCapabilities,
): CapabilitySnapshot => ({
  kind: "snapshot",
  generation: "connection",
  revision,
  services,
});
const patch = (
  revision: number,
  services: CapabilityChanges,
): CapabilityAnnouncement => ({
  kind: "patch",
  generation: "connection",
  revision,
  services,
});
const idle = {
  host: true,
  request: true,
  occupancy: { state: "idle" as const },
};
const busy = {
  ...idle,
  occupancy: {
    state: "controlled" as const,
    clientId: "viewer",
    sourceId: "display",
  },
};

it("merges independent capabilities even when a newer patch arrives first", () => {
  const state = new CapabilityState();
  state.apply(
    snapshot(1, {
      control: idle,
      speedTest: { busy: false },
    }),
  );
  state.apply(patch(3, { speedTest: { busy: true } }));
  state.apply(patch(2, { control: busy }));
  expect(state.value).toEqual({
    control: busy,
    speedTest: { busy: true },
  });
  state.apply(patch(1, { control: idle }));
  expect(state.value!.control).toEqual(busy);
});

it("does not discover partial state before the initial snapshot and preserves earlier-arriving updates", () => {
  const state = new CapabilityState();
  state.apply(
    patch(4, { control: busy, "acme.whiteboard": null }),
  );
  state.apply(patch(3, { speedTest: { busy: true } }));
  expect(state.value).toBeUndefined();
  expect(
    state.apply(
      snapshot(1, {
        control: idle,
        speedTest: { busy: false },
        "acme.whiteboard": { enabled: true },
      }),
    ),
  ).toBe("changed");
  expect(state.value).toEqual({
    control: busy,
    speedTest: { busy: true },
  });
});

it("keeps withdrawals across stale patches and snapshots, then permits a newer reannouncement", () => {
  const state = new CapabilityState();
  state.apply(
    snapshot(1, { "acme.whiteboard": { enabled: true } }),
  );
  state.apply(patch(4, { "acme.whiteboard": null }));
  state.apply(
    patch(3, { "acme.whiteboard": { enabled: true } }),
  );
  state.apply(
    snapshot(2, { "acme.whiteboard": { enabled: true } }),
  );
  expect(state.value).toEqual({});
  state.apply(
    patch(5, { "acme.whiteboard": { mode: "view" } }),
  );
  expect(state.value).toEqual({
    "acme.whiteboard": { mode: "view" },
  });
});

it("uses a full snapshot as the absence baseline without overwriting newer entries", () => {
  const state = new CapabilityState();
  state.apply(
    snapshot(1, {
      files: { content: true, shared: true },
      control: idle,
    }),
  );
  state.apply(patch(6, { control: busy }));
  state.apply(
    snapshot(4, {
      speedTest: { busy: false },
      control: idle,
    }),
  );
  state.apply(
    patch(3, { files: { content: true, shared: true } }),
  );
  expect(state.value).toEqual({
    control: busy,
    speedTest: { busy: false },
  });
});

it("replaces an entry entirely and retains its revision even if its data did not change", () => {
  const state = new CapabilityState();
  state.apply(
    snapshot(1, {
      "acme.whiteboard": { oldField: true, mode: "edit" },
    }),
  );
  state.apply(
    patch(4, { "acme.whiteboard": { mode: "view" } }),
  );
  expect(
    state.apply(
      patch(6, { "acme.whiteboard": { mode: "view" } }),
    ),
  ).toBe("ignored");
  state.apply(
    patch(5, { "acme.whiteboard": { mode: "edit" } }),
  );
  expect(state.value).toEqual({
    "acme.whiteboard": { mode: "view" },
  });
});

it("pins discovery to one connection generation", () => {
  const state = new CapabilityState();
  state.apply(snapshot(1, { control: busy }));
  expect(
    state.apply({
      ...patch(9, { control: idle }),
      generation: "other",
    }),
  ).toBe("ignored");
  expect(
    state.apply({
      ...snapshot(10, {}),
      generation: "other",
    }),
  ).toBe("ignored");
  expect(state.value).toEqual({ control: busy });
});

it("bounds the merged service map and recovers through a new snapshot while preserving newer patches", () => {
  const state = new CapabilityState();
  const full = Object.fromEntries(
    Array.from({ length: 32 }, (_, i) => [
      `plugin-${i}`,
      {},
    ]),
  );
  state.apply(snapshot(1, full));
  expect(state.apply(patch(2, { control: busy }))).toBe(
    "resync",
  );
  expect(state.value).toBeUndefined();
  expect(state.apply(snapshot(1, full))).toBe("ignored");
  state.apply(patch(4, { speedTest: { busy: true } }));
  state.apply(snapshot(3, { control: busy }));
  expect(state.value).toEqual({
    control: busy,
    speedTest: { busy: true },
  });
});

it("bounds retained deletion versions and compacts them with a full snapshot", () => {
  const state = new CapabilityState();
  state.apply(snapshot(1, {}));
  for (let i = 0; i < 128; i++)
    expect(
      state.apply(patch(i + 2, { [`plugin-${i}`]: null })),
    ).toBe("ignored");
  expect(state.apply(patch(130, { another: null }))).toBe(
    "resync",
  );
  expect(state.value).toBeUndefined();
  state.apply(snapshot(131, { control: busy }));
  state.apply(patch(130, { control: idle }));
  expect(state.value).toEqual({ control: busy });
});

it("only includes changed entries and explicit removals in a patch", () => {
  expect(
    changedCapabilities(
      {
        control: idle,
        files: { content: true, shared: true },
      },
      {
        control: idle,
        "acme.whiteboard": { mode: "edit" },
      },
    ),
  ).toEqual({
    files: null,
    "acme.whiteboard": { mode: "edit" },
  });
});

it("treats extension names as own keys when withdrawing them", () => {
  const state = new CapabilityState();
  state.apply(snapshot(1, { toString: { enabled: true } }));
  expect(changedCapabilities(state.value!, {})).toEqual({
    toString: null,
  });
  state.apply(snapshot(2, {}));
  expect(state.value).toEqual({});
});

it("converges to the same state for every ordering of snapshots, patches and duplicate deliveries", () => {
  const messages = [
    snapshot(1, {
      control: idle,
      files: { content: true, shared: true },
    }),
    patch(2, { control: busy }),
    patch(3, { files: null }),
    patch(4, {
      "acme.whiteboard": { mode: "edit", oldField: true },
    }),
    snapshot(5, {
      control: busy,
      "acme.whiteboard": { mode: "view" },
    }),
    patch(6, { control: idle, speedTest: { busy: true } }),
  ];
  const checkOrders = (
    remaining: CapabilityAnnouncement[],
    order: CapabilityAnnouncement[] = [],
  ) => {
    if (!remaining.length) {
      const state = new CapabilityState();
      for (const message of order) {
        state.apply(message);
        state.apply(message);
      }
      expect(state.value).toEqual({
        control: idle,
        speedTest: { busy: true },
        "acme.whiteboard": { mode: "view" },
      });
      return;
    }
    for (const [index, message] of remaining.entries())
      checkOrders(
        remaining.filter((_, i) => i !== index),
        [...order, message],
      );
  };
  checkOrders(messages);
});
