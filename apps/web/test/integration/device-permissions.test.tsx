import { createPeerTrustMock } from "../support/peer-trust";
import userEvent from "@testing-library/user-event";
import {
  AppStateContext,
  type AppStateContextProps,
} from "@/libs/state/app-state-context";
import { resetClientConfig } from "@/libs/state/permission-options";
import {
  permissionGroupIds,
  permissionGroups,
} from "@weblink/automation";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { ClientPermissions } from "@/components/settings/client-permissions";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import type { PairingRequest } from "@/libs/domain/device-identity/manual-pairing";
import { setClientConfig } from "@/options";
import type { PeerTrust } from "@/libs/application/peer-trust";
const fixture = vi.hoisted(() => ({
  get: undefined as undefined | (() => PeerTrust),
  pairing: undefined as
    | undefined
    | (() => PairingRequest | undefined),
  request: vi.fn(),
  respond: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {
    trust: createPeerTrustMock({
      get: () => fixture.get?.(),
      pairing: () => fixture.pairing?.(),
      requestPairing: (...args: unknown[]) =>
        fixture.request(...args),
      respondPairing: (...args: unknown[]) =>
        fixture.respond(...args),
      cancelPairing: (...args: unknown[]) =>
        fixture.cancel(...args),
    }),
  },
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
beforeEach(() => {
  vi.clearAllMocks();
  fixture.pairing = undefined;
  setAppState("session", "clientViewData", "peer", {
    clientId: "peer",
    messageChannel: true,
    onlineStatus: "online",
  } as any);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("locks every permission for an untrusted device and restores defaults only after the other device confirms repair", async () => {
  const [trust, setTrust] = createSignal<PeerTrust>({
    state: "untrusted",
    fingerprint: "key",
  });
  fixture.get = trust;
  setClientConfig("peer", {
    receiveContent: true,
    shareScreen: true,
    provideFileList: true,
    remoteControl: "allow",
  });
  const [pairing, setPairing] =
    createSignal<PairingRequest>();
  fixture.pairing = pairing;
  fixture.request.mockImplementation(async () => {
    setPairing({ id: "request", state: "outgoing" });
  });
  renderDevice();
  expect(
    screen.queryByRole("switch"),
  ).not.toBeInTheDocument();
  const binaryLabels = [
    "device_trust.receive_content",
    "device_trust.share_screen",
    "client.config.provide_file_list.title",
  ];
  const permission = (label: string) =>
    screen.getByRole("button", {
      name: (name) => name.startsWith(label),
    });
  for (const label of binaryLabels) {
    expect(permission(label)).toBeDisabled();
    expect(permission(label)).toHaveTextContent(
      "setting.permissions.disallowed",
    );
  }
  for (const label of [
    "app_menu.settings_remote_control",
    "client.config.provide_file_list.title",
  ])
    expect(
      screen.getByRole("button", {
        name: (n) => n.startsWith(label),
      }),
    ).toBeDisabled();
  const repair = screen.getByRole("button", {
    name: "device_trust.repair",
  });
  expect(repair).toBeEnabled();
  expect(
    screen.queryByRole("checkbox"),
  ).not.toBeInTheDocument();
  fireEvent.click(repair);
  await waitFor(() =>
    expect(fixture.request).toHaveBeenCalledWith("peer"),
  );
  expect(
    screen.getByText("device_trust.waiting_confirmation"),
  ).toBeInTheDocument();
  expect(permission(binaryLabels[0])).toBeDisabled();
  resetClientConfig("peer");
  setPairing(undefined);
  setTrust({ ...trust(), state: "trusted" });
  for (const label of binaryLabels) {
    expect(permission(label)).toBeEnabled();
    expect(permission(label)).toHaveTextContent(
      "setting.permissions.allowed",
    );
  }
  expect(
    permission("app_menu.settings_remote_control"),
  ).toHaveTextContent("setting.permissions.ask");
  for (const group of permissionGroupIds)
    expect(
      permission(`automation.permissions.${group}.title`),
    ).toHaveTextContent("setting.permissions.ask");
  const receive = permission(
    "device_trust.receive_content",
  );
  await userEvent.click(receive);
  await userEvent.click(
    screen.getByRole("option", {
      name: "setting.permissions.disallowed",
    }),
  );
  expect(
    appState.options.clientConfigs.peer?.receiveContent,
  ).toBe(false);
  expect(
    appState.options.clientConfigs.peer?.shareScreen,
  ).toBe(true);
  setTrust({ state: "untrusted" });
  expect(receive).toBeDisabled();
  expect(receive).toHaveTextContent(
    "setting.permissions.disallowed",
  );
  expect(
    screen.queryByRole("button", {
      name: "device_trust.repair",
    }),
  ).toBeEnabled();
});

function renderDevice(desktop = true) {
  return render(() => (
    <AppStateContext.Provider
      value={
        {
          automation: { desktop, enabled: () => false },
        } as AppStateContextProps
      }
    >
      <ClientPermissions clientId="peer" />
    </AppStateContext.Provider>
  ));
}
it.each(["allow", "deny", "ask"] as const)(
  "saves %s as the device policy without request or grant lists",
  async (decision) => {
    fixture.get = () => ({ state: "trusted" });
    resetClientConfig("peer");
    setClientConfig("peer", {
      automation: {
        "shell.execute":
          decision === "ask" ? "allow" : "ask",
      },
    });
    const decide = vi.fn();
    const revoke = vi.fn();
    const principal = {
      id: "peer",
      kind: "peer",
      label: "Peer",
    };
    render(() => (
      <AppStateContext.Provider
        value={
          {
            automation: {
              desktop: true,
              enabled: () => true,
              decide,
              revoke,
              snapshot: () => ({
                policiesSuspended: false,
                pending: [
                  {
                    id: "review",
                    principal,
                    scope: "shell.execute",
                    tool: "commands.start",
                    arguments: { target: "local" },
                  },
                ],
                grants: [
                  {
                    id: "grant",
                    principal,
                    scopes: ["shell.execute"],
                    target: "local",
                    expiresAt: Date.now() + 60000,
                  },
                ],
              }),
            },
          } as unknown as AppStateContextProps
        }
      >
        <ClientPermissions clientId="peer" />
      </AppStateContext.Provider>
    ));
    expect(
      screen.queryByText("automation.requests"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("automation.grants"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: "common.action.revoke",
      }),
    ).not.toBeInTheDocument();
    const permission = () =>
      screen.getByRole("button", {
        name: (name) =>
          name.startsWith(
            "automation.permissions.terminal.title",
          ),
      });
    await userEvent.click(permission());
    await userEvent.click(
      screen.getByRole("option", {
        name:
          decision === "allow"
            ? "setting.permissions.allow_permanently"
            : `setting.permissions.${decision}`,
      }),
    );
    expect(
      appState.options.clientConfigs.peer?.automation?.[
        "shell.execute"
      ],
    ).toBe(decision);
    expect(decide).not.toHaveBeenCalled();
    expect(revoke).not.toHaveBeenCalled();
  },
);
it("saves per-device policies and keeps read permissions available in browsers", async () => {
  fixture.get = () => ({ state: "trusted" });
  resetClientConfig("peer");
  const view = renderDevice();
  const label = "automation.permissions.terminal.title";
  await userEvent.click(
    screen.getByRole("button", {
      name: (n) => n.startsWith(label),
    }),
  );
  await userEvent.click(
    screen.getByRole("option", {
      name: "setting.permissions.allow_permanently",
    }),
  );
  expect(
    appState.options.clientConfigs.peer?.automation?.[
      "shell.execute"
    ],
  ).toBe("allow");
  expect(
    appState.options.clientConfigs.peer?.automation?.[
      "input.control"
    ],
  ).toBeUndefined();
  resetClientConfig("peer");
  expect(
    appState.options.clientConfigs.peer?.automation,
  ).toBeUndefined();
  expect(
    screen.getByRole("button", {
      name: (n) => n.startsWith(label),
    }),
  ).toHaveTextContent("setting.permissions.ask");
  view.unmount();
  renderDevice(false);
  expect(screen.queryByText(label)).not.toBeInTheDocument();
  const read = screen.getByRole("button", {
    name: (name) =>
      name.startsWith("automation.permissions.read.title"),
  });
  await userEvent.click(read);
  await userEvent.click(
    screen.getByRole("option", {
      name: "setting.permissions.allow_permanently",
    }),
  );
  expect(
    appState.options.clientConfigs.peer?.automation?.[
      "diagnostics.read"
    ],
  ).toBe("allow");
});
it("groups every automation scope by purpose and locks it for an untrusted device", () => {
  fixture.get = () => ({ state: "untrusted" });
  setClientConfig("peer", {
    automation: { "shell.execute": "allow" },
  });
  renderDevice();
  const region = screen.getByRole("region", {
    name: "automation.title",
  });
  expect(
    within(region).getAllByRole("button"),
  ).toHaveLength(3);
  for (const group of permissionGroupIds) {
    const control = within(region).getByRole("button", {
      name: (name) =>
        name.startsWith(
          `automation.permissions.${group}.title`,
        ),
    });
    expect(control).toBeDisabled();
    expect(control).toHaveTextContent(
      "setting.permissions.deny",
    );
  }
});
it("preserves mixed legacy permissions until a group is explicitly changed", async () => {
  fixture.get = () => ({ state: "trusted" });
  resetClientConfig("peer");
  const legacy = {
    "diagnostics.read": "allow",
    "screen.read": "deny",
    "shell.execute": "allow",
  } as const;
  setClientConfig("peer", { automation: legacy });
  renderDevice();
  const read = screen.getByRole("button", {
    name: (name) =>
      name.startsWith("automation.permissions.read.title"),
  });
  expect(read).toHaveTextContent(
    "automation.mixed_permissions",
  );
  expect(
    appState.options.clientConfigs.peer?.automation,
  ).toEqual(legacy);
  await userEvent.click(read);
  await userEvent.click(
    screen.getByRole("option", {
      name: "setting.permissions.ask",
    }),
  );
  const policy =
    appState.options.clientConfigs.peer?.automation;
  for (const scope of permissionGroups.read)
    expect(policy?.[scope]).toBe("ask");
  expect(policy?.["shell.execute"]).toBe("allow");
  expect(policy?.["input.control"]).toBeUndefined();
});

it("offers accept/reject even when the local side is still trusted", () => {
  fixture.get = () => ({ state: "trusted" });
  const [pairing, setPairing] =
    createSignal<PairingRequest>({
      id: "incoming",
      state: "incoming",
    });
  fixture.pairing = pairing;
  renderDevice();
  fireEvent.click(
    screen.getByRole("button", {
      name: "common.action.deny",
    }),
  );
  expect(fixture.respond).toHaveBeenCalledWith(
    "peer",
    "incoming",
    false,
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "common.action.accept",
    }),
  );
  expect(fixture.respond).toHaveBeenCalledWith(
    "peer",
    "incoming",
    true,
  );
  setPairing({ id: "incoming", state: "committing" });
  expect(
    screen.queryByRole("button", {
      name: "common.action.accept",
    }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByText("device_trust.saving_pairing"),
  ).toBeInTheDocument();
});

it("supports cancellation, shows expiry, and disables requests offline", () => {
  fixture.get = () => ({ state: "untrusted" });
  const [pairing, setPairing] =
    createSignal<PairingRequest>({
      id: "request",
      state: "outgoing",
    });
  fixture.pairing = pairing;
  renderDevice();
  fireEvent.click(
    screen.getByRole("button", {
      name: "common.action.cancel",
    }),
  );
  expect(fixture.cancel).toHaveBeenCalledWith(
    "peer",
    "request",
  );
  setPairing({
    id: "request",
    state: "failed",
    reason: "timeout",
  });
  expect(screen.getByRole("alert")).toHaveTextContent(
    "device_trust.failure.timeout",
  );
  setAppState(
    "session",
    "clientViewData",
    "peer",
    "messageChannel",
    false,
  );
  expect(
    screen.getByRole("button", {
      name: "device_trust.repair",
    }),
  ).toBeDisabled();
});

it("shows transport recovery before identity verification without enabling permissions", () => {
  fixture.get = () => ({ state: "verifying" });
  setAppState("session", "clientViewData", "peer", {
    onlineStatus: "reconnecting",
    messageChannel: false,
  });
  renderDevice();
  expect(screen.getByRole("status")).toHaveTextContent(
    "common.status.reconnecting",
  );
  expect(
    screen.queryByText("device_trust.verifying"),
  ).not.toBeInTheDocument();
  setAppState("session", "clientViewData", "peer", {
    onlineStatus: "online",
    messageChannel: true,
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "device_trust.verifying",
  );
  setAppState("session", "clientViewData", "peer", {
    onlineStatus: "offline",
    // The connection status can arrive before the channel-close event.
    messageChannel: true,
  });
  expect(screen.getByRole("status")).toHaveTextContent(
    "common.status.offline",
  );
  expect(
    screen.getByRole("button", {
      name: "device_trust.repair",
    }),
  ).toBeDisabled();
});
