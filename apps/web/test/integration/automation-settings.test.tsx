import AutomationPermissions from "@/components/settings/automation-permissions";
import { useAppState } from "@/libs/state/app-state-context";
// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createSignal } from "solid-js";
import { BaseDialog } from "@/components/dialogs/dialog";
import { ResponsiveTabs } from "@/components/ui/responsive-tabs";
import {
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import AutomationSettings from "@/components/settings/automation-settings";
import type { AutomationRuntime } from "@/libs/state/create-automation";
const fixture = vi.hoisted(() => ({
  scope: "shell.execute",
  desktop: true,
  webSupported: true,
  enabled: true,
  mcpEnabled: true,
  jobs: [] as ReturnType<
    AutomationRuntime["snapshot"]
  >["jobs"],
  audit: [] as ReturnType<
    AutomationRuntime["snapshot"]
  >["audit"],
  configure: vi.fn(async (_enabled: boolean) => {}),
  configureMcp: vi.fn(async (_enabled: boolean) => {}),
  expiresAt: null as number | null,
  endpoints: () => ["http://127.0.0.1:123/mcp"],
  server: () => ({
    host: "127.0.0.1",
    port: 123,
  }),
  configureServer: vi.fn(
    async (config: { host: string; port: number }) =>
      config,
  ),
  client: vi.fn(
    async (_label: string, _expiresAt: number | null) => ({
      id: "local-token",
      token: "secret-token",
      endpoint: "http://127.0.0.1:123/mcp",
    }),
  ),
  updateClient: vi.fn(
    async (
      _id: string,
      _label: string,
      _expiresAt: number | null,
    ) => {},
  ),
  removeClient: vi.fn(async () => {}),
  decide: vi.fn(async () => {}),
  revoke: vi.fn(async () => {}),
}));
vi.mock("@/i18n", () => ({
  t: (key: string, values?: { code?: string }) =>
    values?.code ? `${key} ${values.code}` : key,
}));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: vi.fn(() => ({
    automation: {
      enabled: () => fixture.enabled,
      configuredEnabled: () => fixture.enabled,
      mcpEnabled: () => fixture.mcpEnabled,
      configuredMcpEnabled: () => fixture.mcpEnabled,
      active: () => fixture.enabled || fixture.mcpEnabled,
      ready: () => true,
      error: () => "",
      get desktop() {
        return fixture.desktop;
      },
      configureServer: fixture.configureServer,
      client: fixture.client,
      updateClient: fixture.updateClient,
      removeClient: fixture.removeClient,
      webSupported: () => fixture.webSupported,
      configure: fixture.configure,
      configureMcp: fixture.configureMcp,
      decide: fixture.decide,
      revoke: fixture.revoke,
      export: () => ({}),
      peers: () => [],
      snapshot: () => ({
        server: fixture.server(),
        serverPending:
          fixture.mcpEnabled &&
          (fixture.server().host !== "127.0.0.1" ||
            fixture.server().port !== 123),
        endpoint: fixture.mcpEnabled
          ? "http://127.0.0.1:123/mcp"
          : "",
        endpoints: fixture.mcpEnabled
          ? fixture.endpoints()
          : [],
        pending: [
          {
            id: "request",
            principal: {
              id: "peer",
              label: "Remote",
              kind: "peer",
            },
            scope: fixture.scope,
            tool: "commands.start",
            arguments: {
              target: "local",
              script: "echo test",
            },
          },
        ],
        grants: [],
        audit: fixture.audit,
        jobs: fixture.jobs,
        clients: [
          {
            id: "saved",
            label: "Saved local token",
            prefix: "12345678",
            createdAt: 1700000000000,
            expiresAt: fixture.expiresAt,
            expired: false,
          },
        ],
      }),
    },
  })),
}));
let animationStyle: HTMLStyleElement;
beforeEach(() => {
  const [server, setServer] = createSignal({
    host: "127.0.0.1",
    port: 123,
  });
  fixture.server = server;
  fixture.configureServer.mockImplementation(
    async (config) => {
      const committed = {
        ...config,
        host: config.host.trim(),
      };
      setServer(committed);
      return committed;
    },
  );
  animationStyle = document.createElement("style");
  animationStyle.textContent =
    "* { animation-name: none !important; }";
  document.head.append(animationStyle);
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});
afterEach(async () => {
  cleanup();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  fixture.scope = "shell.execute";
  fixture.expiresAt = null;
  fixture.updateClient.mockReset();
  fixture.desktop = true;
  fixture.webSupported = true;
  fixture.enabled = true;
  fixture.mcpEnabled = true;
  fixture.jobs = [];
  fixture.audit = [];
  fixture.endpoints = () => ["http://127.0.0.1:123/mcp"];
  fixture.server = () => ({ host: "127.0.0.1", port: 123 });
  fixture.configureServer.mockReset();
  animationStyle.remove();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
it.each([false, true])(
  "keeps unsupported WebMCP off and disabled with saved preference %s",
  async (enabled) => {
    fixture.desktop = false;
    fixture.webSupported = false;
    fixture.mcpEnabled = enabled;
    render(() => <AutomationSettings />);
    const toggle = screen.getByRole("switch", {
      name: "automation.mcp_enable",
    });
    expect(toggle).toBeDisabled();
    expect(toggle).not.toBeChecked();
    expect(
      screen.getByText("automation.unsupported"),
    ).toBeVisible();
    await userEvent.click(toggle);
    expect(fixture.configureMcp).not.toHaveBeenCalled();
  },
);
it("shows recent calls and diagnostic codes without a duplicate command task list", () => {
  fixture.jobs = [
    "running",
    "completed",
    "cancelled",
    "timed_out",
    "future_status",
  ].map((status) => ({
    id: `job-${status}`,
    principal: "local-token",
    status,
    exitCode: status === "completed" ? 7 : null,
    truncated: false,
  }));
  fixture.audit = ["ok", "error", "PERMISSION_DENIED"].map(
    (status) => ({
      id: `call-${status}`,
      principal: "Local token",
      at: 1700000000000,
      tool: "commands.run",
      target: "local",
      status,
    }),
  );
  render(() => <AutomationSettings />);
  expect(screen.queryByText("automation.jobs")).toBeNull();
  expect(screen.queryByText("job-running")).toBeNull();
  expect(
    screen.getByText(/automation.call_status.ok/),
  ).toBeVisible();
  expect(
    screen.getByText(/automation.call_status.error$/),
  ).toBeVisible();
  expect(
    screen.getByText(
      /automation.call_status.error_code PERMISSION_DENIED/,
    ),
  ).toBeVisible();
  expect(screen.getAllByText("commands.run")).toHaveLength(
    3,
  );
});
it.each([false, true])(
  "allows MCP on desktop=%s",
  async (desktop) => {
    fixture.desktop = desktop;
    fixture.webSupported = !desktop;
    fixture.mcpEnabled = false;
    render(() => <AutomationSettings />);
    const toggle = screen.getByRole("switch", {
      name: "automation.mcp_enable",
    });
    expect(toggle).toBeEnabled();
    await userEvent.click(toggle);
    expect(fixture.configureMcp).toHaveBeenCalledWith(true);
  },
);
it("shows a separate privacy explanation for accessibility inspection", () => {
  fixture.scope = "accessibility.read";
  render(() => (
    <AutomationPermissions
      runtime={useAppState().automation!}
      peerId="peer"
    />
  ));
  expect(
    screen.getByText(
      "automation.permissions.read.description",
    ),
  ).toBeVisible();
  expect(
    screen.getByText(/automation.permissions.read.title/),
  ).toBeVisible();
  expect(
    screen.getByRole("button", {
      name: "automation.allow",
    }),
  ).toBeEnabled();
});
it("approves a paired device request without a second verification code", async () => {
  render(() => (
    <AutomationPermissions
      runtime={useAppState().automation!}
      peerId="peer"
    />
  ));
  const allow = screen.getByRole("button", {
    name: "automation.allow",
  });
  expect(allow).toBeEnabled();
  expect(
    screen.getByText(
      "automation.permissions.terminal.description",
    ),
  ).toBeVisible();
  expect(
    screen.queryByRole("checkbox"),
  ).not.toBeInTheDocument();
  expect(allow).toBeEnabled();
  fireEvent.click(allow);
  expect(fixture.decide).toHaveBeenCalledWith(
    "request",
    15,
  );
});
it("denies a paired device request without a separate automation stop button", () => {
  render(() => (
    <>
      <AutomationSettings />
      <AutomationPermissions
        runtime={useAppState().automation!}
        peerId="peer"
      />
    </>
  ));
  fireEvent.click(
    screen.getByRole("button", { name: "automation.deny" }),
  );
  expect(fixture.decide).toHaveBeenCalledWith("request", 0);
  expect(
    screen.queryByRole("button", {
      name: "automation.stop",
    }),
  ).not.toBeInTheDocument();
});
it("manages local tokens without a second approval list on desktop", () => {
  render(() => <AutomationSettings />);
  expect(
    screen.getByText("Saved local token"),
  ).toBeVisible();
  expect(
    screen.queryByText("automation.requests"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("automation.grants"),
  ).not.toBeInTheDocument();
});
it("keeps local token management and approval UI off the Web controller", () => {
  fixture.desktop = false;
  render(() => <AutomationSettings />);
  expect(
    screen.queryByText("automation.server"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("automation.clients"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("automation.requests"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Saved local token"),
  ).not.toBeInTheDocument();
});
it("creates permanent and timed local MCP tokens", async () => {
  render(() => <AutomationSettings />);
  expect(
    screen.queryByRole("textbox", {
      name: "automation.client_name",
    }),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", {
      name: "automation.create_client",
    }),
  );
  await screen.findByRole("dialog");
  fireEvent.input(
    screen.getByRole("textbox", {
      name: "automation.client_name",
    }),
    { target: { value: "Local agent" } },
  );
  await userEvent.click(
    screen.getByRole("button", {
      name: /automation.token_lifetime/,
    }),
  );
  await userEvent.click(
    screen.getByRole("option", {
      name: "automation.permanent",
    }),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "automation.create_client",
    }),
  );
  expect(fixture.client).toHaveBeenCalledWith(
    "Local agent",
    null,
  );
  await screen.findByText(/secret-token/);
  fireEvent.click(
    screen.getByRole("button", { name: "automation.hide" }),
  );
  expect(
    screen.queryByText(/secret-token/),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", {
      name: "automation.create_client",
    }),
  );
  await screen.findByRole("dialog");
  fireEvent.input(
    screen.getByRole("textbox", {
      name: "automation.client_name",
    }),
    { target: { value: "Timed agent" } },
  );
  await userEvent.click(
    screen.getByRole("button", {
      name: /automation.token_lifetime/,
    }),
  );
  await userEvent.click(
    screen.getByRole("option", {
      name: "7 automation.days",
    }),
  );
  const before = Date.now();
  fireEvent.click(
    screen.getByRole("button", {
      name: "automation.create_client",
    }),
  );
  const expiry = fixture.client.mock.calls.at(-1)?.[1];
  expect(expiry).toBeGreaterThanOrEqual(
    before + 7 * 86400000,
  );
  expect(expiry).toBeLessThanOrEqual(
    Date.now() + 7 * 86400000,
  );
});

it("automatically edits and revokes tokens while automation is off", async () => {
  fixture.mcpEnabled = false;
  render(() => <AutomationSettings />);
  await userEvent.click(
    screen.getByRole("button", {
      name: "automation.edit_token: Saved local token",
    }),
  );
  expect(
    screen.queryByRole("button", {
      name: "automation.save_token",
    }),
  ).not.toBeInTheDocument();
  const name = screen.getByRole("textbox", {
    name: "automation.client_name",
  });
  fireEvent.input(name, {
    target: { value: "Renamed agent" },
  });
  fireEvent.blur(name);
  await waitFor(() =>
    expect(fixture.updateClient).toHaveBeenCalledWith(
      "saved",
      "Renamed agent",
      null,
    ),
  );
  await userEvent.click(
    screen.getByRole("button", {
      name: "common.action.close",
    }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog"),
    ).not.toBeInTheDocument(),
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "automation.revoke: Saved local token",
    }),
  );
  expect(fixture.removeClient).toHaveBeenCalledWith(
    "saved",
  );
});
it("creates a token while disabled using the configured fixed endpoint", async () => {
  fixture.mcpEnabled = false;
  fixture.client.mockResolvedValueOnce({
    id: "offline",
    token: "secret-token",
    endpoint: "http://127.0.0.1:32100/mcp",
  });
  render(() => <AutomationSettings />);
  await userEvent.click(
    screen.getByRole("button", {
      name: "automation.create_client",
    }),
  );
  fireEvent.input(
    screen.getByRole("textbox", {
      name: "automation.client_name",
    }),
    { target: { value: "Offline agent" } },
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "automation.create_client",
    }),
  );
  const secret = await screen.findByText(
    /Bearer secret-token/,
  );
  expect(secret.textContent).toContain(
    "http://127.0.0.1:32100/mcp",
  );
  expect(
    screen.queryByText("automation.token_endpoint_pending"),
  ).not.toBeInTheDocument();
  await userEvent.click(
    screen.getByRole("button", { name: "automation.hide" }),
  );
  expect(
    screen.queryByText(/secret-token/),
  ).not.toBeInTheDocument();
});
it("automatically saves running listener settings for the next start", async () => {
  render(() => <AutomationSettings />);
  const host = screen.getByRole("textbox", {
    name: "automation.server_host",
  });
  const port = screen.getByRole("spinbutton", {
    name: "automation.server_port",
  });
  expect(host).toBeEnabled();
  expect(port).toBeEnabled();
  expect(
    screen.queryByRole("button", {
      name: "automation.server_save",
    }),
  ).not.toBeInTheDocument();
  fireEvent.input(host, { target: { value: " ::1 " } });
  fireEvent.input(port, { target: { value: "4321" } });
  fireEvent.blur(port);
  await waitFor(() =>
    expect(fixture.configureServer).toHaveBeenCalledWith({
      host: "::1",
      port: 4321,
    }),
  );
  expect(
    await screen.findByText("automation.settings_saved"),
  ).toBeVisible();
  expect(
    screen.getByText("automation.server_pending"),
  ).toBeVisible();
  expect(
    screen.getByText("http://127.0.0.1:123/mcp"),
  ).toBeVisible();
  expect(fixture.configure).not.toHaveBeenCalled();
});
it("lists complete live connection URLs and refreshes network addresses without using pending settings", async () => {
  const [endpoints, setEndpoints] = createSignal([
    "http://127.0.0.1:123/mcp",
    "http://192.168.1.20:123/mcp",
    "http://10.0.0.5:123/mcp",
  ]);
  fixture.endpoints = endpoints;
  render(() => <AutomationSettings />);
  for (const endpoint of endpoints()) {
    expect(screen.getByText(endpoint)).toBeVisible();
  }
  const port = screen.getByRole("spinbutton", {
    name: "automation.server_port",
  });
  fireEvent.input(port, { target: { value: "4321" } });
  fireEvent.blur(port);
  await screen.findByText("automation.server_pending");
  expect(
    screen.getByText("http://192.168.1.20:123/mcp"),
  ).toBeVisible();
  expect(
    screen.queryByText("http://192.168.1.20:4321/mcp"),
  ).not.toBeInTheDocument();
  setEndpoints([
    "http://127.0.0.1:123/mcp",
    "http://192.168.2.30:123/mcp",
  ]);
  expect(
    screen.getByText("http://192.168.2.30:123/mcp"),
  ).toBeVisible();
  expect(
    screen.queryByText("http://192.168.1.20:123/mcp"),
  ).not.toBeInTheDocument();
});
it("validates automatic writes and restores the default host and port", async () => {
  fixture.mcpEnabled = false;
  render(() => <AutomationSettings />);
  const port = screen.getByRole("spinbutton", {
    name: "automation.server_port",
  });
  for (const value of ["", "0", "-1", "65536", "1.5"]) {
    fireEvent.input(port, { target: { value } });
    fireEvent.blur(port);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "automation.server_invalid_port",
    );
  }
  expect(fixture.configureServer).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", {
      name: "automation.server_reset",
    }),
  );
  await waitFor(() =>
    expect(fixture.configureServer).toHaveBeenCalledWith({
      host: "127.0.0.1",
      port: 32100,
    }),
  );
  await screen.findByText("automation.settings_saved");
  expect(port).toHaveValue(32100);
  expect(
    screen.queryByRole("button", {
      name: "automation.server_reset",
    }),
  ).not.toBeInTheDocument();
});
it("keeps an edited draft through status polling and late save responses", async () => {
  let resolve!: () => void;
  const [server, setServer] = createSignal({
    host: "127.0.0.1",
    port: 123,
  });
  fixture.server = server;
  fixture.configureServer.mockImplementationOnce(
    async (config) => {
      await new Promise<void>((done) => {
        resolve = done;
      });
      setServer(config);
      return config;
    },
  );
  render(() => <AutomationSettings />);
  const host = screen.getByRole("textbox", {
    name: "automation.server_host",
  });
  fireEvent.input(host, { target: { value: "0.0.0.0" } });
  fireEvent.blur(host);
  await waitFor(() => expect(resolve).toBeDefined());
  fireEvent.input(host, { target: { value: "::1" } });
  setServer({ host: "127.0.0.1", port: 123 });
  expect(host).toHaveValue("::1");
  resolve();
  await waitFor(() =>
    expect(
      screen.queryByText("automation.saving"),
    ).not.toBeInTheDocument(),
  );
  expect(host).toHaveValue("::1");
  expect(
    screen.queryByText("automation.settings_saved"),
  ).not.toBeInTheDocument();
});
it("keeps the draft and reports automatic save errors", async () => {
  fixture.configureServer.mockRejectedValueOnce(
    new Error("INVALID_MCP_HOST"),
  );
  render(() => <AutomationSettings />);
  const host = screen.getByRole("textbox", {
    name: "automation.server_host",
  });
  fireEvent.input(host, {
    target: { value: "https://example.com" },
  });
  fireEvent.blur(host);
  expect(
    await screen.findByRole("alert"),
  ).toHaveTextContent("automation.server_invalid_host");
  expect(host).toHaveValue("https://example.com");
  expect(
    screen.queryByText("automation.settings_saved"),
  ).not.toBeInTheDocument();
});
it("restores the default token lifetime automatically without changing its name", async () => {
  fixture.mcpEnabled = false;
  render(() => <AutomationSettings />);
  await userEvent.click(
    screen.getByRole("button", {
      name: "automation.edit_token: Saved local token",
    }),
  );
  const before = Date.now();
  fireEvent.click(
    screen.getByRole("button", {
      name: "automation.token_reset",
    }),
  );
  await waitFor(() =>
    expect(fixture.updateClient).toHaveBeenCalledOnce(),
  );
  const [id, name, expiry] =
    fixture.updateClient.mock.calls[0];
  expect(id).toBe("saved");
  expect(name).toBe("Saved local token");
  expect(expiry).toBeGreaterThanOrEqual(
    before + 30 * 86400000,
  );
  expect(expiry).toBeLessThanOrEqual(
    Date.now() + 30 * 86400000,
  );
  expect(
    screen.queryByRole("button", {
      name: "automation.token_reset",
    }),
  ).not.toBeInTheDocument();
});
it("preserves the exact expiration timestamp when only renaming a token", async () => {
  fixture.expiresAt = Date.now() + 7 * 86400000 + 12345;
  render(() => <AutomationSettings />);
  await userEvent.click(
    screen.getByRole("button", {
      name: "automation.edit_token: Saved local token",
    }),
  );
  fireEvent.input(
    screen.getByRole("textbox", {
      name: "automation.client_name",
    }),
    { target: { value: "New name" } },
  );
  // Closing also flushes the focused field, with no Save action.
  await userEvent.click(
    screen.getByRole("button", {
      name: "common.action.close",
    }),
  );
  await waitFor(() =>
    expect(fixture.updateClient).toHaveBeenCalledWith(
      "saved",
      "New name",
      fixture.expiresAt,
    ),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole("dialog"),
    ).not.toBeInTheDocument(),
  );
});
it("keeps the edit dialog open after a failed automatic write", async () => {
  fixture.updateClient.mockRejectedValueOnce(
    new Error("AUTOMATION_STORAGE_UNAVAILABLE"),
  );
  render(() => <AutomationSettings />);
  await userEvent.click(
    screen.getByRole("button", {
      name: "automation.edit_token: Saved local token",
    }),
  );
  fireEvent.input(
    screen.getByRole("textbox", {
      name: "automation.client_name",
    }),
    { target: { value: "New name" } },
  );
  fireEvent.click(
    screen.getByRole("button", {
      name: "common.action.close",
    }),
  );
  expect(
    await screen.findByRole("alert"),
  ).toHaveTextContent("AUTOMATION_STORAGE_UNAVAILABLE");
  expect(screen.getByRole("dialog")).toBeVisible();
  expect(
    screen.getByRole("textbox", {
      name: "automation.client_name",
    }),
  ).toHaveValue("New name");
});
it("cancels an uncreated token draft without creating a credential", async () => {
  render(() => <AutomationSettings />);
  await userEvent.click(
    screen.getByRole("button", {
      name: "automation.create_client",
    }),
  );
  const dialog = await screen.findByRole("dialog");
  fireEvent.input(
    within(dialog).getByRole("textbox", {
      name: "automation.client_name",
    }),
    { target: { value: "Draft" } },
  );
  await userEvent.click(
    within(dialog).getByRole("button", {
      name: "common.action.cancel",
    }),
  );
  expect(fixture.client).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("dialog"),
  ).not.toBeInTheDocument();
});

it("persists the final valid listener draft when settings close without blur", async () => {
  const view = render(() => <AutomationSettings />);
  fireEvent.input(
    screen.getByRole("textbox", {
      name: "automation.server_host",
    }),
    { target: { value: "::1" } },
  );
  view.unmount();
  await waitFor(() =>
    expect(fixture.configureServer).toHaveBeenCalledWith({
      host: "::1",
      port: 123,
    }),
  );
});

it("keeps device approvals isolated from other devices and local MCP clients", () => {
  const runtime = useAppState().automation!;
  const snapshot = runtime.snapshot();
  const request = snapshot.pending[0];
  runtime.snapshot = () => ({
    ...snapshot,
    pending: [
      {
        ...request,
        id: "chosen",
        principal: {
          ...request.principal,
          id: "peer",
          label: "Chosen device",
        },
      },
      {
        ...request,
        id: "other",
        principal: {
          ...request.principal,
          id: "other-peer",
          label: "Other device",
        },
      },
      {
        ...request,
        id: "token",
        principal: {
          id: "local-token",
          label: "Local MCP client",
          kind: "mcp",
        },
      },
    ],
  });
  const view = render(() => (
    <AutomationPermissions
      runtime={runtime}
      peerId="peer"
    />
  ));
  expect(screen.getByText("Chosen device")).toBeVisible();
  expect(
    screen.queryByText("Other device"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Local MCP client"),
  ).not.toBeInTheDocument();
  view.unmount();
  render(() => (
    <AutomationPermissions
      runtime={runtime}
      peerId="other-peer"
    />
  ));
  expect(
    screen.queryByText("Local MCP client"),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByText("Chosen device"),
  ).not.toBeInTheDocument();
  expect(screen.getByText("Other device")).toBeVisible();
});

it.each([false, true])(
  "shows a local automation switch only on desktop=%s",
  async (desktop) => {
    fixture.desktop = desktop;
    fixture.enabled = false;
    fixture.mcpEnabled = true;
    render(() => <AutomationSettings />);
    const local = screen.queryByRole("switch", {
      name: "automation.enable",
    });
    expect(local !== null).toBe(desktop);
    expect(
      screen.getByRole("switch", {
        name: "automation.mcp_enable",
      }),
    ).toBeChecked();
    if (local) {
      expect(local).not.toBeChecked();
      expect(
        screen.getByText("automation.server_active"),
      ).toBeVisible();
      await userEvent.click(local);
      expect(fixture.configure).toHaveBeenCalledWith(true);
      expect(fixture.configureMcp).not.toHaveBeenCalled();
    }
  },
);

it("shows MCP stopped while local automation remains enabled", () => {
  fixture.enabled = true;
  fixture.mcpEnabled = false;
  render(() => <AutomationSettings />);
  expect(
    screen.getByRole("switch", {
      name: "automation.enable",
    }),
  ).toBeChecked();
  expect(
    screen.getByRole("switch", {
      name: "automation.mcp_enable",
    }),
  ).not.toBeChecked();
  expect(
    screen.getByText("automation.server_inactive"),
  ).toBeVisible();
});

it.each(["automation", "mcp"] as const)(
  "keeps the pending %s switch focusable and the other switch available",
  async (feature) => {
    const action =
      feature === "automation"
        ? fixture.configure
        : fixture.configureMcp;
    const otherAction =
      feature === "automation"
        ? fixture.configureMcp
        : fixture.configure;
    let finish!: () => void;
    action.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(() => <AutomationSettings />);
    const user = userEvent.setup();
    const toggle = screen.getByRole("switch", {
      name:
        feature === "automation"
          ? "automation.enable"
          : "automation.mcp_enable",
    });
    const other = screen.getByRole("switch", {
      name:
        feature === "automation"
          ? "automation.mcp_enable"
          : "automation.enable",
    });
    await user.click(toggle);
    expect(action).toHaveBeenCalledOnce();
    expect(toggle).not.toBeDisabled();
    expect(toggle).toHaveAttribute("aria-readonly", "true");
    expect(toggle).toHaveFocus();
    await user.keyboard(" ");
    await user.click(toggle);
    expect(action).toHaveBeenCalledOnce();
    expect(other).not.toBeDisabled();
    await user.click(other);
    expect(otherAction).toHaveBeenCalledOnce();
    finish();
    await waitFor(() =>
      expect(toggle).not.toHaveAttribute(
        "aria-readonly",
        "true",
      ),
    );
    await user.click(toggle);
    expect(action).toHaveBeenCalledTimes(2);
  },
);

it("keeps the settings page and focused drafts mounted across switch and service updates", async () => {
  const state = useAppState();
  const original = state.automation!;
  const [enabled, setEnabled] = createSignal(true);
  const [mcpEnabled, setMcpEnabled] = createSignal(true);
  const [pending, setPending] = createSignal(false);
  const runtime = {
    ...original,
    enabled,
    configuredEnabled: enabled,
    mcpEnabled,
    configuredMcpEnabled: mcpEnabled,
    active: () => enabled() || mcpEnabled(),
    configure: async (value: boolean) => {
      setEnabled(value);
    },
    configureMcp: async (value: boolean) => {
      setMcpEnabled(value);
    },
    snapshot: () => ({
      ...original.snapshot(),
      serverPending: pending(),
    }),
  };
  vi.mocked(useAppState).mockReturnValueOnce({
    ...state,
    automation: runtime,
  });
  render(() => (
    <BaseDialog
      isOpen={true}
      title="Settings"
      content={
        <ResponsiveTabs value="automation">
          <TabsList>
            <TabsTrigger value="automation">
              Automation
            </TabsTrigger>
          </TabsList>
          <TabsContent value="automation">
            <AutomationSettings />
          </TabsContent>
        </ResponsiveTabs>
      }
    />
  ));
  const user = userEvent.setup();
  const page = screen.getByRole("region", {
    name: "automation.title",
  });
  const host = screen.getByRole("textbox", {
    name: "automation.server_host",
  }) as HTMLInputElement;
  const local = screen.getByRole("switch", {
    name: "automation.enable",
  });
  const mcp = screen.getByRole("switch", {
    name: "automation.mcp_enable",
  });
  const create = screen.getByRole("button", {
    name: "automation.create_client",
  });
  await user.click(local);
  expect(enabled()).toBe(false);
  expect(
    screen.getByRole("region", {
      name: "automation.title",
    }),
  ).toBe(page);
  expect(
    screen.getByRole("textbox", {
      name: "automation.server_host",
    }),
  ).toBe(host);
  expect(
    screen.getByRole("switch", {
      name: "automation.enable",
    }),
  ).toBe(local);
  await user.click(mcp);
  expect(mcpEnabled()).toBe(false);
  expect(
    screen.getByRole("textbox", {
      name: "automation.server_host",
    }),
  ).toBe(host);
  expect(
    screen.getByRole("button", {
      name: "automation.create_client",
    }),
  ).toBe(create);
  await user.click(host);
  await user.clear(host);
  await user.type(host, "192.168.1.20");
  host.setSelectionRange(2, 6);
  setMcpEnabled(true);
  setPending(true);
  expect(
    screen.getByRole("textbox", {
      name: "automation.server_host",
    }),
  ).toBe(host);
  expect(document.activeElement).toBe(host);
  expect(host.value).toBe("192.168.1.20");
  expect([host.selectionStart, host.selectionEnd]).toEqual([
    2, 6,
  ]);
  expect(fixture.configureServer).not.toHaveBeenCalled();
});
