// @vitest-environment jsdom
import {
  beforeEach,
  afterEach,
  expect,
  it,
  vi,
} from "vitest";
import { reconcile } from "solid-js/store";
import { resetAutomationPolicies } from "@/libs/state/automation-policy-reset";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import { getDefaultAppOptions } from "@/libs/state/app-options";
import { resolveStoredAppOptions } from "@/libs/state/stored-app-options";

beforeEach(() => {
  localStorage.clear();
  setAppState("options", reconcile(getDefaultAppOptions()));
  setAppState("options", "clientConfigs", {
    online: {
      provideFileList: false,
      name: "Online",
      automation: {
        "screen.read": "allow",
        "shell.execute": "deny",
      },
    },
    offline: {
      provideFileList: false,
      name: "Offline",
      automation: {
        "input.control": "allow",
        "diagnostics.read": "ask",
      },
    },
  });
});
afterEach(() => vi.restoreAllMocks());

it("persists ask for online and offline allows, retaining denials and other settings across reload", () => {
  resetAutomationPolicies("stop-1");
  const saved = resolveStoredAppOptions(
    JSON.parse(localStorage.getItem("app_options")!),
  );
  expect(saved.automationPolicyGeneration).toBe("stop-1");
  expect(saved.clientConfigs.online?.automation).toEqual({
    "screen.read": "ask",
    "shell.execute": "deny",
  });
  expect(saved.clientConfigs.offline?.automation).toEqual({
    "input.control": "ask",
    "diagnostics.read": "ask",
  });
  expect(saved.clientConfigs.offline?.name).toBe("Offline");
  setAppState("options", reconcile(saved));
  setAppState(
    "options",
    "clientConfigs",
    "online",
    "automation",
    "screen.read",
    "allow",
  );
  resetAutomationPolicies("stop-1");
  expect(
    appState.options.clientConfigs.online?.automation?.[
      "screen.read"
    ],
  ).toBe("allow");
  resetAutomationPolicies("stop-2");
  expect(
    appState.options.clientConfigs.online?.automation?.[
      "screen.read"
    ],
  ).toBe("ask");
});

it("does not acknowledge a failed settings write or reset policies on ordinary startup", () => {
  resetAutomationPolicies("");
  expect(
    appState.options.clientConfigs.online?.automation?.[
      "screen.read"
    ],
  ).toBe("allow");
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(
    () => {
      throw new Error("Storage unavailable");
    },
  );
  expect(() => resetAutomationPolicies("stop-1")).toThrow(
    "Storage unavailable",
  );
  expect(
    appState.options.automationPolicyGeneration,
  ).toBeUndefined();
});
