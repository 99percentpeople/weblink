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
import { appState } from "@/libs/state/app-state";
import { setClientConfig } from "@/options";
import type { PeerTrust } from "@/libs/application/peer-trust";
const fixture = vi.hoisted(() => ({
  get: undefined as undefined | (() => PeerTrust),
  pair: vi.fn(),
}));
vi.mock("@/libs/application/session-service", () => ({
  sessionService: {
    trust: {
      get: () => fixture.get?.(),
      pair: (...args: unknown[]) => fixture.pair(...args),
    },
  },
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("locks every permission for an untrusted device and restores defaults after code-confirmed repair", async () => {
  const [trust, setTrust] = createSignal<PeerTrust>({
    state: "untrusted",
    fingerprint: "key",
    code: "1234567890abcdef",
  });
  fixture.get = trust;
  setClientConfig("peer", {
    receiveContent: true,
    shareScreen: true,
    provideFileList: true,
    remoteControl: "allow",
  });
  fixture.pair.mockImplementation(async () => {
    resetClientConfig("peer");
    setTrust({ ...trust(), state: "trusted" });
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
  expect(repair).toBeDisabled();
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "device_trust.confirm_code",
    }),
  );
  fireEvent.click(repair);
  await waitFor(() =>
    expect(fixture.pair).toHaveBeenCalledWith(
      "peer",
      "key",
      "1234567890abcdef",
    ),
  );
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
  ).not.toBeInTheDocument();
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
it("saves per-device scope policies immediately, resets them, and hides them on the Web controller", async () => {
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
