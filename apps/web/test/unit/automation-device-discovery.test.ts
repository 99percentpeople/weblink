import { expect, it } from "vitest";
import {
  isDiagnosticTool,
  tools,
} from "@weblink/automation";
import type { RuntimeCapabilities } from "@weblink/platform";
import { validCurrentCapability } from "@/libs/domain/protocol/capabilities";
import {
  automationDeviceDiscovery,
  localAutomationCapability,
} from "@/libs/application/automation/device-discovery";

const windows: RuntimeCapabilities = {
  runtime: "desktop",
  os: "windows",
  version: "1.2.3",
  nativeScreenCapture: true,
  displayRefreshRates: [60],
  remoteInput: true,
};

it("distinguishes a connected browser's diagnostics from desktop automation", () => {
  const capability = localAutomationCapability(
    { kind: "browser" },
    undefined,
    true,
  );
  const result = automationDeviceDiscovery(
    capability,
    "connected",
  );
  expect(result).toMatchObject({
    runtime: "browser",
    automationEnabled: false,
    automationConnection: "connected",
    disabledReason: "browser_runtime",
    permissionsVerified: false,
    supportedTools: tools
      .filter((tool) => isDiagnosticTool(tool.name))
      .map((tool) => tool.name),
  });
  expect(result.supportedTools).not.toContain(
    "commands.run",
  );
  expect(result.supportedTools).not.toContain(
    "accessibility.action",
  );
  const local = localAutomationCapability(
    { kind: "browser" },
    undefined,
    false,
    true,
  );
  expect(local.supportedTools).toContain("devices.list");
  expect(local.supportedTools).toContain(
    "commands.capabilities",
  );
  expect(result.supportedTools).not.toContain(
    "devices.list",
  );
});

it("keeps implemented desktop tools when automation is disabled without claiming permission", () => {
  const capability = localAutomationCapability(
    { kind: "desktop" },
    windows,
    false,
  );
  const result = automationDeviceDiscovery(
    capability,
    "connecting",
  );
  expect(result).toMatchObject({
    runtime: "desktop",
    os: "windows",
    appVersion: "1.2.3",
    automationEnabled: false,
    automationConnection: "connecting",
    disabledReason: "automation_disabled",
    permissionsVerified: false,
  });
  expect(result.supportedTools).toContain("commands.run");
  expect(result.supportedTools).toContain(
    "accessibility.action",
  );
  expect(result.supportedTools).toContain(
    "control.pointer",
  );
  expect(
    localAutomationCapability(
      { kind: "desktop" },
      windows,
      true,
    ).supportedTools,
  ).toEqual(capability.supportedTools);
});

it("does not turn a legacy automation announcement into a desktop capability claim", () => {
  expect(
    automationDeviceDiscovery(
      { diagnostics: true },
      "connected",
    ),
  ).toEqual({
    runtime: null,
    os: null,
    appVersion: null,
    automationEnabled: null,
    automationConnection: "connected",
    supportedTools: null,
    disabledReason: "capabilities_unavailable",
    permissionsVerified: false,
  });
  const unknown = localAutomationCapability(
    { kind: "desktop" },
    undefined,
    true,
  );
  expect(
    automationDeviceDiscovery(unknown, "local"),
  ).toMatchObject({
    supportedTools: null,
    disabledReason: "capabilities_unavailable",
  });
});

it("uses native support rather than advertising Windows-only controls on another OS", () => {
  const capability = localAutomationCapability(
    { kind: "desktop" },
    {
      ...windows,
      os: "linux",
      remoteInput: false,
      nativeScreenCapture: false,
    },
    true,
  );
  expect(capability.supportedTools).toContain(
    "commands.run",
  );
  expect(capability.supportedTools).toContain(
    "accessibility.capabilities",
  );
  expect(capability.supportedTools).not.toContain(
    "accessibility.snapshot",
  );
  expect(capability.supportedTools).not.toContain(
    "control.pointer",
  );
  expect(capability.supportedTools).not.toContain(
    "control.screenshot",
  );
  expect(capability.supportedTools).not.toContain(
    "screen.start",
  );
});

it("accepts compatible old/new descriptors and rejects malformed or unbounded discovery metadata", () => {
  expect(validCurrentCapability("automation", {})).toBe(
    true,
  );
  expect(
    validCurrentCapability("automation", {
      diagnostics: true,
    }),
  ).toBe(true);
  const discovery = localAutomationCapability(
    { kind: "desktop" },
    windows,
    true,
  );
  expect(
    validCurrentCapability("automation", discovery),
  ).toBe(true);
  for (const patch of [
    { runtime: "terminal" },
    { os: "x".repeat(129) },
    { appVersion: 3 },
    { automationEnabled: "true" },
    { supportedTools: ["commands.run", "commands.run"] },
    { supportedTools: [""] },
    {
      supportedTools: Array.from(
        { length: 129 },
        (_, i) => `tool.${i}`,
      ),
    },
  ])
    expect(
      validCurrentCapability("automation", {
        ...discovery,
        ...patch,
      }),
    ).toBe(false);
});
