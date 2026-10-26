import {
  isDiagnosticTool,
  tools,
} from "@weblink/automation";
import type {
  PlatformRuntime,
  RuntimeCapabilities,
} from "@weblink/platform";
import type { AutomationCapability } from "../../domain/protocol/capabilities";

export type AutomationConnection =
  | "local"
  | "connected"
  | "connecting"
  | "disconnected"
  | "unknown";

export interface AutomationDeviceDiscovery {
  runtime: "browser" | "desktop" | null;
  os: string | null;
  appVersion: string | null;
  automationEnabled: boolean | null;
  automationConnection: AutomationConnection;
  supportedTools: string[] | null;
  disabledReason:
    | "browser_runtime"
    | "automation_disabled"
    | "capabilities_unavailable"
    | null;
  /** Discovery does not acquire a grant or query another caller's permissions. */
  permissionsVerified: false;
}

export interface DeviceDiscoverySource {
  local(): AutomationCapability;
  connection(id: string): AutomationConnection;
}

/** Describe implementation support separately from the current automation switch. */
export function localAutomationCapability(
  platform: Pick<PlatformRuntime, "kind">,
  capabilities: RuntimeCapabilities | undefined,
  enabled: boolean,
  local = false,
): AutomationCapability {
  const runtime = platform.kind;
  const supportedTools =
    runtime === "browser"
      ? tools.filter(
          (tool) =>
            isDiagnosticTool(tool.name) ||
            (local &&
              [
                "devices.list",
                "commands.capabilities",
              ].includes(tool.name)),
        )
      : capabilities
        ? tools.filter((tool) => {
            if (
              tool.name.startsWith("accessibility.") &&
              tool.name !== "accessibility.capabilities"
            )
              return capabilities.os === "windows";
            if (tool.name === "control.screenshot")
              return capabilities.nativeScreenCapture;
            if (tool.name.startsWith("control."))
              return capabilities.remoteInput;
            if (
              tool.name === "screen.sources" ||
              tool.name === "screen.start"
            )
              return capabilities.nativeScreenCapture;
            return true;
          })
        : undefined;
  return {
    runtime,
    os:
      capabilities?.os ??
      (runtime === "browser" ? "browser" : null),
    appVersion:
      capabilities?.version ??
      (typeof __APP_VERSION__ === "string"
        ? __APP_VERSION__
        : null),
    automationEnabled: runtime === "desktop" && enabled,
    ...(supportedTools
      ? {
          supportedTools: supportedTools.map(
            (tool) => tool.name,
          ),
        }
      : {}),
  };
}

/** Missing legacy metadata stays unknown; an automation channel may be diagnostic-only. */
export function automationDeviceDiscovery(
  capability: AutomationCapability | undefined,
  connection: AutomationConnection,
): AutomationDeviceDiscovery {
  const runtime = capability?.runtime ?? null;
  const supportedTools = capability?.supportedTools ?? null;
  return {
    runtime,
    os: capability?.os ?? null,
    appVersion: capability?.appVersion ?? null,
    automationEnabled:
      capability?.automationEnabled ?? null,
    automationConnection: connection,
    supportedTools: supportedTools
      ? [...supportedTools]
      : null,
    disabledReason:
      runtime === "browser"
        ? "browser_runtime"
        : runtime === "desktop" &&
            capability?.automationEnabled === false
          ? "automation_disabled"
          : !runtime || !supportedTools
            ? "capabilities_unavailable"
            : null,
    permissionsVerified: false,
  };
}
