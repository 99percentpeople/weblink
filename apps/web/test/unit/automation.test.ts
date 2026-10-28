import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  tools,
  parseCall,
  validate,
  AutomationError,
  scopes,
  permissionGroups,
  permissionScopes,
  groupDecision,
  setGroupDecision,
  type Principal,
  type ToolCall,
} from "@weblink/automation";
import { AutomationAudit } from "@/libs/application/automation/audit";
import { AutomationDiagnostics } from "@/libs/application/automation/diagnostics";
import { registerWebMcp } from "@weblink/automation/webmcp";
const principal: Principal = {
  id: "page",
  label: "Page",
  kind: "webmcp",
};
const call: ToolCall = {
  name: "diagnostics.snapshot",
  arguments: { target: "local" },
};
afterEach(() => vi.useRealTimers());
it("bounds browser audit history without retaining tool arguments", () => {
  const audit = new AutomationAudit(
    () => {},
    () => 1000,
  );
  for (let i = 0; i < 1001; i++)
    audit.record(principal, call, String(i));
  expect(audit.entries).toHaveLength(1000);
  expect(audit.entries[0].status).toBe("1");
  expect(audit.entries.at(-1)).toMatchObject({
    at: 1000,
    principal: "Page",
    tool: call.name,
    target: "local",
    status: "1000",
  });
  expect(audit.entries[0]).not.toHaveProperty("arguments");
});
describe("shared tool contract", () => {
  it("acquires by exactly one capture source or existing track", () => {
    for (const arguments_ of [
      { target: "peer", sourceId: "monitor" },
      { target: "local", trackId: "live-track" },
    ])
      expect(() =>
        parseCall({
          name: "control.acquire",
          arguments: arguments_,
        }),
      ).not.toThrow();
    for (const arguments_ of [
      { target: "local" },
      {
        target: "local",
        sourceId: "monitor",
        trackId: "track",
      },
      { target: "local", sourceId: "" },
      { target: "local", sourceId: 1 },
      { sourceId: "monitor" },
    ])
      expect(() =>
        parseCall({
          name: "control.acquire",
          arguments: arguments_,
        }),
      ).toThrow(AutomationError);
  });
  it("maps every current scope to exactly one group and preserves legacy mixed decisions", () => {
    expect(
      Object.values(permissionGroups).flat().sort(),
    ).toEqual([...scopes].sort());
    expect(permissionScopes("shell.execute")).toEqual([
      "shell.execute",
    ]);
    expect(groupDecision(undefined, "read")).toBe("ask");
    const legacy = {
      "diagnostics.read": "allow",
      "screen.read": "deny",
      "shell.execute": "allow",
    } as const;
    expect(groupDecision(legacy, "read")).toBeNull();
    const updated = setGroupDecision(legacy, "read", "ask");
    expect(groupDecision(updated, "read")).toBe("ask");
    expect(groupDecision(updated, "terminal")).toBe(
      "allow",
    );
    expect(legacy["screen.read"]).toBe("deny");
  });
  it("separates accessibility inspection from control and bounds subtree requests", () => {
    const byName = new Map(
      tools.map((tool) => [tool.name, tool]),
    );
    expect(byName.get("accessibility.windows")?.scope).toBe(
      "accessibility.read",
    );
    expect(
      byName.get("accessibility.snapshot")?.scope,
    ).toBe("accessibility.read");
    expect(byName.get("accessibility.action")?.scope).toBe(
      "input.control",
    );
    expect(() =>
      parseCall({
        name: "accessibility.snapshot",
        arguments: {
          target: "peer",
          elementId: "opaque",
          maxNodes: 256,
          maxDepth: 8,
        },
      }),
    ).not.toThrow();
    for (const arguments_ of [
      {
        target: "local",
        elementId: "opaque",
        maxNodes: 257,
      },
      { target: "local", elementId: "opaque", maxDepth: 9 },
      {
        target: "local",
        elementId: "opaque",
        processId: 1,
      },
    ])
      expect(() =>
        parseCall({
          name: "accessibility.snapshot",
          arguments: arguments_,
        }),
      ).toThrow(AutomationError);
    expect(() =>
      parseCall({
        name: "accessibility.action",
        arguments: {
          target: "local",
          elementId: "opaque",
          action: "evaluateScript",
        },
      }),
    ).toThrow(AutomationError);
  });
  it("shares physical coordinates and distinct run/start arguments across transports", () => {
    const parse = (
      name: string,
      args: Record<string, unknown>,
    ) =>
      parseCall({
        name,
        arguments: { target: "local", ...args },
      });
    expect(() =>
      parse("control.pointer", { x: 0.5, y: 1 }),
    ).toThrow(AutomationError);
    expect(() =>
      parse("control.pointer", { x: -100, y: 0 }),
    ).toThrow(AutomationError);
    const physical = {
      action: "move",
      coordinateSpace: "desktopPhysicalPixels",
      sourceId: "monitor",
      geometryRevision: "rev",
      x: -100,
      y: 0,
    };
    expect(() =>
      parse("control.pointer", physical),
    ).not.toThrow();
    for (const key of [
      "coordinateSpace",
      "sourceId",
      "geometryRevision",
    ]) {
      const args: Record<string, unknown> = { ...physical };
      delete args[key];
      expect(() => parse("control.pointer", args)).toThrow(
        AutomationError,
      );
    }
    for (const coordinateSpace of [
      "sourceNormalized",
      "cssPixels",
    ])
      expect(() =>
        parse("control.pointer", {
          ...physical,
          coordinateSpace,
        }),
      ).toThrow(AutomationError);
    expect(() =>
      parse("commands.run", {
        script: "echo ok",
        waitMs: 60000,
        timeoutMs: 600000,
      }),
    ).not.toThrow();
    for (const waitMs of [0, 60001, 1.5])
      expect(() =>
        parse("commands.run", {
          script: "echo ok",
          waitMs,
        }),
      ).toThrow(AutomationError);
    expect(() =>
      parse("commands.start", {
        script: "echo ok",
        waitMs: 1,
      }),
    ).toThrow(AutomationError);
    expect(
      parse("commands.run", { script: "echo ok" }).scope,
    ).toBe(
      parse("commands.start", { script: "echo ok" }).scope,
    );
  });
  it("validates pointer gestures, bounded paths and action-specific arguments", () => {
    const base = {
      target: "local",
      action: "move",
      coordinateSpace: "desktopPhysicalPixels",
      sourceId: "monitor",
      geometryRevision: "rev",
      x: -100,
      y: 10,
    };
    const parse = (args: Record<string, unknown>) =>
      parseCall({
        name: "control.pointer",
        arguments: { ...base, ...args },
      });
    for (const args of [
      {},
      { action: "down", button: "back" },
      { action: "up" },
      {
        action: "move",
        path: [{ x: -50, y: 20 }],
        durationMs: 500,
      },
      {
        action: "drag",
        path: [{ x: -50, y: 20 }],
        button: "left",
        durationMs: 10000,
      },
      {
        action: "click",
        clickCount: 2,
        holdMs: 30,
        intervalMs: 120,
      },
      { action: "scroll", scrollX: 120, scrollY: 0 },
    ])
      expect(() => parse(args)).not.toThrow();
    for (const args of [
      { action: undefined },
      { button: "left" },
      { durationMs: 500 },
      { action: "drag" },
      { path: [] },
      { path: Array(129).fill({ x: 0, y: 0 }) },
      { path: [{ x: 1 }] },
      { path: [{ x: 1, y: 2, extra: true }] },
      { path: [{ x: Infinity, y: 0 }] },
      { path: [{ x: 0, y: 0 }], durationMs: 10001 },
      { action: "click", clickCount: 3 },
      { action: "click", intervalMs: 39 },
      { action: "click", holdMs: 2001 },
      { action: "scroll", scrollY: 120 },
      { action: "scroll", scrollX: 1201, scrollY: 0 },
      { action: "down", path: [{ x: 0, y: 0 }] },
    ])
      expect(() => parse(args)).toThrow(AutomationError);
  });
  it("rejects authority fields, invalid limits and unknown tools", () => {
    expect(() =>
      parseCall({
        name: "commands.start",
        arguments: {
          target: "local",
          script: "echo",
          approved: true,
        },
      }),
    ).toThrow(AutomationError);
    expect(() =>
      parseCall({
        name: "commands.start",
        arguments: {
          target: "local",
          script: "echo",
          timeoutMs: 600001,
        },
      }),
    ).toThrow(AutomationError);
    expect(() =>
      parseCall({
        name: "permissions.approve",
        arguments: { target: "local" },
      }),
    ).toThrow(AutomationError);
    expect(() =>
      parseCall({
        name: "commands.start",
        arguments: {
          target: "local",
          script: "echo",
          timeoutMs: 600000,
        },
      }),
    ).not.toThrow();
    expect(
      validate({ type: "string", maxLength: 1 }, "😀"),
    ).toBe(true);
    for (const tool of tools)
      expect(
        validate(tool.inputSchema, {
          target: "local",
          unexpected: true,
        }),
      ).toBe(false);
  });
  it("WebMCP uses the same catalog and propagates cancellation, then unregisters", async () => {
    const registered: Parameters<
      Parameters<typeof registerWebMcp>[0]["registerTool"]
    >[0][] = [];
    const signals: AbortSignal[] = [];
    const context = {
      registerTool: vi.fn<
        Parameters<typeof registerWebMcp>[0]["registerTool"]
      >(async (tool, { signal }) => {
        registered.push(tool);
        signals.push(signal);
      }),
    };
    const invoke = vi.fn(async () => ({
      ok: true as const,
      data: {},
    }));
    const close = await registerWebMcp(context, invoke);
    expect(registered.map((t) => t.name)).toEqual(
      tools.map((t) => t.name),
    );
    const signal = new AbortController().signal;
    await registered[0].execute(
      { target: "local" },
      { signal },
    );
    expect(invoke).toHaveBeenCalledWith(
      {
        name: tools[0].name,
        arguments: { target: "local" },
      },
      signal,
    );
    close();
    expect(signals).toHaveLength(tools.length);
    expect(signals.every((signal) => signal.aborted)).toBe(
      true,
    );
  });
  it("rolls back registered WebMCP tools when a later registration rejects", async () => {
    let first!: AbortSignal;
    const register = vi
      .fn<
        Parameters<typeof registerWebMcp>[0]["registerTool"]
      >(async () => {
        throw new Error("Registration denied");
      })
      .mockImplementationOnce(async (_, { signal }) => {
        first = signal;
      });
    await expect(
      registerWebMcp(
        { registerTool: register },
        async () => ({ ok: true, data: {} }),
      ),
    ).rejects.toThrow("Registration denied");
    expect(register).toHaveBeenCalledTimes(2);
    expect(first.aborted).toBe(true);
  });
});
describe("stream diagnostics", () => {
  it("separates preview from reception, reports gaps and discards reset deltas", async () => {
    let now = 1000,
      frames = 10,
      bytes = 100;
    const diagnostics = new AutomationDiagnostics(
      () => [
        {
          id: "track",
          state: () => ({}),
          read: async () => [
            {
              key: "preview",
              direction: "send" as const,
              preview: true,
              samples: [
                { id: "a", timestamp: now, frames, bytes },
              ],
            },
            {
              key: "remote",
              direction: "receive" as const,
              samples: [
                { id: "b", timestamp: now, frames, bytes },
              ],
            },
          ],
        },
      ],
      () => now,
    );
    await diagnostics.sample();
    now += 1000;
    frames += 20;
    bytes += 200;
    await diagnostics.sample();
    const latest = diagnostics.snapshot().latest as {
      streams: Record<string, unknown>[];
      gapMs: number;
    };
    expect(latest.streams.map((s) => s.preview)).toEqual([
      true,
      false,
    ]);
    expect(latest.streams[0].fps).toBe(20);
    now += 5000;
    frames = 1;
    bytes = 1;
    await diagnostics.sample();
    const reset = diagnostics.snapshot()
      .latest as typeof latest;
    expect(reset.gapMs).toBe(4000);
    expect(reset.streams[0].fps).toBeUndefined();
    now += 300001;
    expect(diagnostics.read().samples).toEqual([]);
    diagnostics.dispose();
  });
  it("records failure instead of inventing valid zero statistics", async () => {
    const d = new AutomationDiagnostics(() => [
      {
        id: "receiver",
        state: () => ({}),
        read: async () => {
          throw new Error("sensitive SDP");
        },
      },
    ]);
    await d.sample();
    expect(JSON.stringify(d.snapshot())).toContain(
      "STATS_UNAVAILABLE:receiver",
    );
    expect(JSON.stringify(d.snapshot())).not.toContain(
      "sensitive SDP",
    );
    d.dispose();
  });
});
