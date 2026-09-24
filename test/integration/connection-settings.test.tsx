// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  describe,
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
import { reconcile } from "solid-js/store";
import type { JSX } from "solid-js";
import { toast } from "solid-sonner";
import { ConnectionSettings } from "@/components/settings/connection-settings";
import {
  appState,
  setAppState,
} from "@/libs/state/app-state";
import type {
  IceServerDiagnostics,
  IceServerDiagnosticResult,
} from "@/libs/application/ice-server-diagnostics";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("solid-sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/options", async () => {
  const options = await import("@/libs/state/app-options");
  const { setAppState } =
    await import("@/libs/state/app-state");
  return {
    ...options,
    setAppOptions: (...args: unknown[]) =>
      Reflect.apply(setAppState, undefined, [
        "options",
        ...args,
      ]),
  };
});

const turn = {
  url: "turn:example",
  username: "user",
  password: "pass",
  authMethod: "longterm",
};
const diagnostics = {
  checkStunServers:
    vi.fn<IceServerDiagnostics["checkStunServers"]>(),
  checkTurnServers:
    vi.fn<IceServerDiagnostics["checkTurnServers"]>(),
};

function fields() {
  const [stun, turn] = screen.getAllByRole(
    "textbox",
  ) as HTMLTextAreaElement[];
  return { stun, turn };
}

function checkButton(field: HTMLTextAreaElement) {
  return within(field.closest("label")!).getByRole(
    "button",
    { name: "common.action.check_availability" },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("VITE_STUN_SERVERS", "");
  vi.stubEnv("VITE_TURN_SERVERS", "");
  setAppState(
    "options",
    "servers",
    reconcile({
      stuns: ["stun:example"],
      turns: [{ ...turn }],
    }),
  );
  setAppState("options", "shareServersWithOthers", false);
  setAppState("profile", "autoJoin", false);
  setAppState("profile", "initalJoin", false);
  diagnostics.checkStunServers.mockResolvedValue([]);
  diagnostics.checkTurnServers.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe("connection settings", () => {
  it("preserves the connection anchor and edits STUN/TURN lists in the shared options", () => {
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    expect(
      screen.getByRole("heading", {
        name: "setting.connection.title",
      }),
    ).toHaveAttribute("id", "connection");
    const { stun, turn } = fields();
    expect(stun.value).toBe("stun:example\n");
    expect(turn.value).toBe(
      "turn:example|user|pass|longterm\n",
    );
    fireEvent.change(stun, {
      target: { value: "stun:first\n\nstun:second\n" },
    });
    expect(appState.options.servers.stuns).toEqual([
      "stun:first",
      "stun:second",
    ]);
    fireEvent.change(turn, {
      target: { value: "turn:new|alice|token|hmac" },
    });
    expect(appState.options.servers.turns).toEqual([
      {
        url: "turn:new",
        username: "alice",
        password: "token",
        authMethod: "hmac",
      },
    ]);
  });

  it("reports invalid TURN input without overwriting valid options", () => {
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    fireEvent.change(fields().turn, {
      target: { value: "invalid" },
    });
    expect(appState.options.servers.turns).toEqual([turn]);
    expect(toast.error).toHaveBeenCalledWith(
      "errors.ice_config_line",
    );
  });

  it("delegates checks and disables only the active check until results arrive", async () => {
    let resolve!: (
      results: IceServerDiagnosticResult[],
    ) => void;
    diagnostics.checkStunServers.mockReturnValue(
      new Promise((yes) => {
        resolve = yes;
      }),
    );
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    const stunCheck = checkButton(fields().stun);
    const turnCheck = checkButton(fields().turn);
    fireEvent.click(stunCheck);
    expect(
      diagnostics.checkStunServers,
    ).toHaveBeenCalledWith(["stun:example"]);
    expect(stunCheck).toBeDisabled();
    expect(turnCheck).not.toBeDisabled();
    resolve([{ server: "stun:example", msg: "available" }]);
    await waitFor(() =>
      expect(stunCheck).not.toBeDisabled(),
    );
    expect(toast.info).toHaveBeenCalledTimes(1);
    const report = vi.mocked(toast.info).mock.calls[0][0];
    expect(typeof report).toBe("function");
    const { container } = render(
      report as () => JSX.Element,
    );
    expect(container.textContent).toContain(
      "stun:example:setting.connection.available",
    );
    fireEvent.click(turnCheck);
    await waitFor(() =>
      expect(
        diagnostics.checkTurnServers,
      ).toHaveBeenCalledWith([turn]),
    );
  });

  it("restores the check button after an unexpected diagnostics failure", async () => {
    diagnostics.checkTurnServers.mockRejectedValue(
      new Error("diagnostics failed"),
    );
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    const button = checkButton(fields().turn);
    fireEvent.click(button);
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "errors.ice_unavailable",
      ),
    );
    expect(button).not.toBeDisabled();
  });

  it("hides availability checks for empty server lists", () => {
    setAppState(
      "options",
      "servers",
      reconcile({ stuns: [], turns: [] }),
    );
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    expect(
      screen.queryByRole("button", {
        name: "common.action.check_availability",
      }),
    ).toBeNull();
  });

  it("retains auto-join and server-sharing switches and the initial-join restriction", () => {
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    const autoJoin = screen.getByRole("switch", {
      name: "setting.connection.auto_join.title",
    });
    const sharing = screen.getByRole("switch", {
      name: "setting.connection.share_servers_with_others.title",
    });
    fireEvent.click(autoJoin);
    fireEvent.click(sharing);
    expect(appState.profile.autoJoin).toBe(true);
    expect(appState.options.shareServersWithOthers).toBe(
      true,
    );
    setAppState("profile", "initalJoin", true);
    expect(autoJoin).toBeDisabled();
  });

  it("resets server lists to deployment defaults", () => {
    vi.stubEnv("VITE_STUN_SERVERS", "stun:default");
    vi.stubEnv(
      "VITE_TURN_SERVERS",
      "turn:default|user|password|longterm",
    );
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    const { stun, turn } = fields();
    fireEvent.click(
      within(stun.closest("label")!).getByRole("button", {
        name: "common.action.reset",
      }),
    );
    fireEvent.click(
      within(turn.closest("label")!).getByRole("button", {
        name: "common.action.reset",
      }),
    );
    expect(appState.options.servers.stuns).toEqual([
      "stun:default",
    ]);
    expect(appState.options.servers.turns).toEqual([
      {
        url: "turn:default",
        username: "user",
        password: "password",
        authMethod: "longterm",
      },
    ]);
  });
});
