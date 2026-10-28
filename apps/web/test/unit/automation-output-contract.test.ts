import { describe, expect, it } from "vitest";
import {
  tools,
  validate,
  parseCall,
  failure,
  AutomationError,
} from "@weblink/automation";
import { AutomationDiagnostics } from "@/libs/application/automation/diagnostics";

const accepts = (
  name: string,
  data: Record<string, unknown>,
) =>
  validate(
    tools.find((tool) => tool.name === name)!.outputSchema,
    { ok: true, data },
  );

describe("published automation output contracts", () => {
  it("describes reusable stream handles without requiring added fields from older targets", () => {
    const legacy = {
      acquired: true,
      reused: false,
      sourceId: "monitor",
      coordinateSpace: "desktopPhysicalPixels",
      geometryRevision: "geometry",
      bounds: {
        left: 0,
        top: 0,
        width: 1920,
        height: 1080,
      },
    };
    expect(accepts("control.acquire", legacy)).toBe(true);
    expect(
      accepts("control.acquire", {
        ...legacy,
        trackId: "track",
      }),
    ).toBe(true);
    for (const shareReused of [false, true]) {
      expect(
        accepts("control.acquire", {
          ...legacy,
          trackId: "track",
          shareReused,
        }),
      ).toBe(true);
      expect(
        accepts("screen.start", {
          trackId: "track",
          sourceId: "monitor",
          reused: shareReused,
        }),
      ).toBe(true);
    }
    expect(
      accepts("screen.start", {
        trackId: "track",
        sourceId: "monitor",
      }),
    ).toBe(true);
    expect(
      accepts("screen.start", {
        trackId: "track",
        sourceId: "monitor",
        reused: "yes",
      }),
    ).toBe(false);
    expect(
      accepts("control.acquire", {
        ...legacy,
        trackId: "",
      }),
    ).toBe(false);
    expect(
      accepts("control.acquire", {
        ...legacy,
        shareReused: "yes",
      }),
    ).toBe(false);
    expect(
      accepts("sessions.list", {
        localTracks: [
          {
            id: "track",
            sourceId: "publication",
            captureSourceId: "monitor",
            state: "live",
            settings: {},
          },
        ],
        peers: [],
      }),
    ).toBe(true);
    expect(
      accepts("sessions.list", {
        localTracks: [
          {
            id: "track",
            captureSourceId: 1,
            state: "live",
            settings: {},
          },
        ],
        peers: [],
      }),
    ).toBe(false);
  });
  it("validates bounded UIA value reads, post-action observation and event-driven waits", () => {
    const parse = (
      name: string,
      args: Record<string, unknown>,
    ) =>
      parseCall({
        name,
        arguments: {
          target: "local",
          elementId: "ref",
          ...args,
        },
      });
    expect(() =>
      parse("accessibility.snapshot", {
        includeValues: true,
        maxTextLength: 4096,
      }),
    ).not.toThrow();
    expect(() =>
      parse("accessibility.action", {
        action: "setValue",
        value: "",
        observeAfter: {
          elementId: "window",
          includeValues: true,
          maxNodes: 64,
        },
      }),
    ).not.toThrow();
    for (const args of [
      { condition: { enabled: true } },
      { condition: { enabled: true }, timeoutMs: 1 },
      {
        condition: { enabled: true, value: "" },
        timeoutMs: 30000,
      },
    ])
      expect(() =>
        parse("accessibility.wait", args),
      ).not.toThrow();
    for (const args of [
      { condition: {} },
      { condition: { checked: true } },
      { condition: { constructor: true } },
      { condition: JSON.parse('{"__proto__": true}') },
      { condition: { enabled: "true" } },
      { condition: { enabled: true }, timeoutMs: 0 },
      { condition: { enabled: true }, timeoutMs: 30001 },
      { condition: { enabled: true }, timeoutMs: 1.5 },
      { condition: { enabled: true }, timeoutMs: null },
      { condition: { enabled: true }, pollIntervalMs: 100 },
      { condition: { textContains: "" } },
    ])
      expect(() =>
        parse("accessibility.wait", args),
      ).toThrow();
    expect(() =>
      parse("accessibility.snapshot", {
        maxTextLength: 4097,
      }),
    ).toThrow();
    expect(() =>
      parse("accessibility.action", {
        action: "invoke",
        observeAfter: { maxNodes: 257 },
      }),
    ).toThrow();
    const wait = tools.find(
      (tool) => tool.name === "accessibility.wait",
    )!;
    expect(wait).toMatchObject({
      native: true,
      readOnly: true,
      scope: "accessibility.read",
      inputSchema: {
        additionalProperties: false,
        properties: {
          timeoutMs: {
            type: "integer",
            minimum: 1,
            maximum: 30000,
            default: 5000,
          },
        },
      },
    });
    expect(wait.inputSchema.properties).not.toHaveProperty(
      "pollIntervalMs",
    );
  });

  it("distinguishes discovery metadata from authorization and describes bounded wait outcomes", () => {
    expect(
      accepts("devices.list", {
        devices: [
          {
            id: "local",
            runtime: "browser",
            os: "browser",
            appVersion: "1.3.2",
            automationEnabled: false,
            supportedTools: ["diagnostics.snapshot"],
            automationConnection: "local",
            disabledReason: "browser_runtime",
            permissionsVerified: false,
          },
          {
            id: "legacy",
            runtime: null,
            os: null,
            appVersion: null,
            automationEnabled: null,
            supportedTools: null,
            automationConnection: "unknown",
            disabledReason: "capabilities_unavailable",
            permissionsVerified: false,
          },
        ],
      }),
    ).toBe(true);
    expect(
      accepts("devices.list", {
        devices: [
          { id: "peer", permissionsVerified: true },
        ],
      }),
    ).toBe(false);
    expect(
      accepts("devices.list", {
        devices: [{ id: "peer", supportedTools: "*" }],
      }),
    ).toBe(false);
    expect(
      accepts("accessibility.wait", {
        matched: false,
        timedOut: true,
        elapsedMs: 5000,
        node: null,
      }),
    ).toBe(true);
    expect(
      accepts("accessibility.wait", {
        matched: false,
        timedOut: true,
        elapsedMs: -1,
        node: null,
      }),
    ).toBe(false);
  });

  it("describes both success and failure for every published tool", () => {
    for (const tool of tools) {
      expect(
        validate(tool.outputSchema, {}),
        tool.name,
      ).toBe(false);
      expect(
        validate(tool.outputSchema, { ok: true }),
        tool.name,
      ).toBe(false);
      expect(
        validate(tool.outputSchema, {
          ok: false,
          error: { message: "missing code" },
        }),
        tool.name,
      ).toBe(false);
      expect(
        validate(
          tool.outputSchema,
          failure(new AutomationError("PERMISSION_DENIED")),
        ),
        tool.name,
      ).toBe(true);
    }
  });

  it("accepts real diagnostic snapshots and pages, including an empty history", async () => {
    const diagnostics = new AutomationDiagnostics(
      () => [],
      () => 1234,
    );
    expect(
      accepts(
        "diagnostics.snapshot",
        diagnostics.snapshot(),
      ),
    ).toBe(true);
    expect(
      accepts("diagnostics.history", diagnostics.read()),
    ).toBe(true);
    expect(
      accepts(
        "diagnostics.start",
        diagnostics.detail(1000),
      ),
    ).toBe(true);
    expect(
      accepts("diagnostics.stop", diagnostics.detail(0)),
    ).toBe(true);
    expect(
      accepts("diagnostics.export", {
        format: "weblink-diagnostics/1",
        generatedAt: 1234,
        runtime: { kind: "web" },
        ...diagnostics.read(),
      }),
    ).toBe(true);
    diagnostics.dispose();
  });

  it("describes screenshot metadata without requiring raw image bytes in text", () => {
    const screenshot = {
      coordinateSpace: "desktopPhysicalPixels",
      sourceId: "monitor",
      geometryRevision: "geometry",
      bounds: {
        left: -2560,
        top: 0,
        width: 2560,
        height: 1440,
      },
      mimeType: "image/png",
      imageWidth: 640,
      imageHeight: 360,
      imageToDesktop: {
        offsetX: -2560,
        offsetY: 0,
        scaleX: 4,
        scaleY: 4,
      },
    };
    expect(accepts("control.screenshot", screenshot)).toBe(
      true,
    );
    expect(
      accepts("control.screenshot", {
        ...screenshot,
        imageWidth: "640",
      }),
    ).toBe(false);
    const { geometryRevision: _, ...incomplete } =
      screenshot;
    expect(accepts("control.screenshot", incomplete)).toBe(
      false,
    );
  });

  it("distinguishes jobs, status, paged output and background handoff", () => {
    const status = {
      status: "running",
      exitCode: null,
      bytes: 5,
      retainedBytes: 5,
      earliestCursor: 0,
      truncated: false,
      outputIncomplete: false,
      stdinStatus: "open",
    };
    const page = {
      ...status,
      chunks: [
        {
          stream: "stdout",
          data: "hello",
          dataBase64: "aGVsbG8=",
        },
      ],
      startCursor: 0,
      nextCursor: 5,
      hasMore: false,
      cursorExpired: false,
      tailLimited: false,
    };
    expect(
      accepts("commands.start", { jobId: "job" }),
    ).toBe(true);
    expect(accepts("commands.status", status)).toBe(true);
    expect(accepts("commands.read", page)).toBe(true);
    expect(
      accepts("commands.run", {
        ...page,
        jobId: "job",
        background: true,
      }),
    ).toBe(true);
    expect(accepts("commands.run", page)).toBe(false);
    expect(
      accepts("commands.read", {
        ...page,
        nextCursor: "5",
      }),
    ).toBe(false);
    expect(
      accepts("commands.status", {
        ...status,
        status: "done",
      }),
    ).toBe(false);
    expect(
      accepts("commands.send", {
        queued: true,
        eof: true,
        bytes: 0,
      }),
    ).toBe(true);
  });

  it("describes nullable UIA parents and capability responses", () => {
    const node = {
      elementId: "ref",
      parentId: null,
      depth: 0,
      role: "window",
      name: "Window",
      automationId: "",
      processId: 12,
      bounds: { x: 0, y: 0, width: 800, height: 600 },
      enabled: true,
      focused: true,
      offscreen: false,
      protected: false,
      actions: ["focus"],
    };
    expect(
      accepts("accessibility.windows", {
        coordinateSpace: "desktopPhysicalPixels",
        windows: [node],
        truncated: false,
        referenceTtlMs: 60000,
      }),
    ).toBe(true);
    expect(
      accepts("accessibility.snapshot", {
        coordinateSpace: "desktopPhysicalPixels",
        nodes: [node],
        truncated: false,
        referenceTtlMs: 60000,
      }),
    ).toBe(true);
    expect(
      accepts("accessibility.capabilities", {
        supported: false,
        backend: null,
        actions: [],
      }),
    ).toBe(true);
    expect(
      accepts("commands.capabilities", {
        supported: true,
        transport: "pipe",
        stdin: true,
        eof: true,
        pty: false,
        supportedSignals: ["SIGTERM", "SIGKILL"],
        signalSemantics: {
          SIGTERM: "terminate-process-tree",
          SIGKILL: "terminate-process-tree",
        },
      }),
    ).toBe(true);
  });
});
