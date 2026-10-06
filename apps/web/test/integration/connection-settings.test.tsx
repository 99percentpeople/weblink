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
import ApplicationSettings from "@/components/settings/application-settings";
import { SettingsStateProvider } from "../helpers/settings-state";
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
  const [stun, turn] = screen.getAllByRole("textbox") as (
    | HTMLInputElement
    | HTMLTextAreaElement
  )[];
  return { stun, turn };
}

function checkButton(
  field: HTMLInputElement | HTMLTextAreaElement,
) {
  return within(field.closest('[role="group"]')!).getByRole(
    "button",
    { name: "common.action.check_availability" },
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("WEBLINK_STUN_SERVERS", "");
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
  it("shows tags and inline inputs, and saves additions, edits and removals", () => {
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    expect(
      screen.getByRole("heading", {
        name: "setting.connection.title",
      }),
    ).toHaveAttribute("id", "connection");
    const { stun, turn: turnInput } = fields();
    expect(stun).toBeInstanceOf(HTMLInputElement);
    expect(turnInput).toBeInstanceOf(HTMLInputElement);
    expect(stun.value).toBe("");
    expect(turnInput.value).toBe("");
    expect(
      screen.getByRole("button", {
        name: "setting.list.edit turn:example · user",
      }),
    ).not.toHaveAttribute(
      "title",
      expect.stringContaining("pass"),
    );
    fireEvent.input(stun, {
      target: { value: "  stun:new  " },
    });
    fireEvent.keyDown(stun, { key: "Enter" });
    expect(appState.options.servers.stuns).toEqual([
      "stun:example",
      "stun:new",
    ]);
    expect(stun.value).toBe("");
    // Adding an existing endpoint should not duplicate it.
    fireEvent.input(stun, {
      target: { value: "stun:new" },
    });
    fireEvent.keyDown(stun, { key: "Enter" });
    expect(appState.options.servers.stuns).toHaveLength(2);
    fireEvent.click(
      screen.getByRole("button", {
        name: "setting.list.edit stun:example",
      }),
    );
    expect(stun.value).toBe("stun:example");
    fireEvent.input(stun, {
      target: { value: "stun:updated" },
    });
    fireEvent.keyDown(stun, { key: "Enter" });
    expect(appState.options.servers.stuns).toEqual([
      "stun:updated",
      "stun:new",
    ]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "setting.list.remove stun:new",
      }),
    );
    expect(appState.options.servers.stuns).toEqual([
      "stun:updated",
    ]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "setting.list.edit turn:example · user",
      }),
    );
    expect(turnInput.value).toBe(
      "turn:example|user|pass|longterm",
    );
    fireEvent.input(turnInput, {
      target: { value: "turn:new|alice|token|hmac" },
    });
    fireEvent.click(
      within(
        turnInput.closest('[role="group"]')!,
      ).getByRole("button", { name: "setting.list.save" }),
    );
    expect(appState.options.servers.turns).toEqual([
      {
        url: "turn:new",
        username: "alice",
        password: "token",
        authMethod: "hmac",
      },
    ]);
  });

  it("keeps invalid inline TURN drafts without overwriting valid options", () => {
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    const input = fields().turn;
    fireEvent.input(input, {
      target: { value: "invalid" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(appState.options.servers.turns).toEqual([turn]);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "errors.ice_config_line",
    );
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input.value).toBe("invalid");
    fireEvent.input(input, {
      target: { value: "turn:new|alice|token|hmac" },
    });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(appState.options.servers.turns).toHaveLength(2);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.value).toBe("");
  });

  it("opens textarea only for bulk editing and saves the whole list explicitly", () => {
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    const group = within(
      fields().stun.closest('[role="group"]')!,
    );
    fireEvent.click(
      group.getByRole("button", {
        name: "setting.list.bulk_edit",
      }),
    );
    const textarea = fields().stun;
    expect(textarea).toBeInstanceOf(HTMLTextAreaElement);
    expect(textarea.value).toBe("stun:example");
    expect(fields().turn).toBeInstanceOf(HTMLInputElement);
    fireEvent.input(textarea, {
      target: {
        value: "stun:first\n\nstun:second\nstun:first\n",
      },
    });
    fireEvent.blur(textarea);
    expect(appState.options.servers.stuns).toEqual([
      "stun:example",
    ]);
    fireEvent.click(
      group.getByRole("button", {
        name: "setting.list.save",
      }),
    );
    expect(appState.options.servers.stuns).toEqual([
      "stun:first",
      "stun:second",
    ]);
    expect(fields().stun).toBeInstanceOf(HTMLInputElement);
    fireEvent.click(
      group.getByRole("button", {
        name: "setting.list.bulk_edit",
      }),
    );
    expect(fields().stun.value).toBe(
      "stun:first\nstun:second",
    );
    fireEvent.input(fields().stun, {
      target: { value: "stun:discard" },
    });
    fireEvent.click(
      group.getByRole("button", {
        name: "common.action.cancel",
      }),
    );
    expect(appState.options.servers.stuns).toEqual([
      "stun:first",
      "stun:second",
    ]);
    expect(fields().stun).toBeInstanceOf(HTMLInputElement);
  });

  it("validates bulk TURN edits atomically and retains invalid text for correction", () => {
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    const group = within(
      fields().turn.closest('[role="group"]')!,
    );
    fireEvent.click(
      group.getByRole("button", {
        name: "setting.list.bulk_edit",
      }),
    );
    const textarea = fields().turn;
    expect(textarea.value).toBe(
      "turn:example|user|pass|longterm",
    );
    const invalid = "turn:first|alice|token|hmac\ninvalid";
    fireEvent.input(textarea, {
      target: { value: invalid },
    });
    fireEvent.click(
      group.getByRole("button", {
        name: "setting.list.save",
      }),
    );
    expect(appState.options.servers.turns).toEqual([turn]);
    expect(textarea.value).toBe(invalid);
    expect(group.getByRole("alert")).toHaveTextContent(
      "errors.ice_config_line",
    );
    const valid =
      "turn:first|alice|token|hmac\nturn:second|bob|secret|longterm";
    fireEvent.input(textarea, { target: { value: valid } });
    fireEvent.click(
      group.getByRole("button", {
        name: "setting.list.save",
      }),
    );
    expect(appState.options.servers.turns).toEqual([
      {
        url: "turn:first",
        username: "alice",
        password: "token",
        authMethod: "hmac",
      },
      {
        url: "turn:second",
        username: "bob",
        password: "secret",
        authMethod: "longterm",
      },
    ]);
    expect(fields().turn).toBeInstanceOf(HTMLInputElement);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("carries a pending tag edit into bulk mode and can cancel without changing options", () => {
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    const group = within(
      fields().stun.closest('[role="group"]')!,
    );
    fireEvent.click(
      group.getByRole("button", {
        name: "setting.list.edit stun:example",
      }),
    );
    fireEvent.input(fields().stun, {
      target: { value: "stun:pending" },
    });
    fireEvent.click(
      group.getByRole("button", {
        name: "setting.list.bulk_edit",
      }),
    );
    expect(fields().stun.value).toBe("stun:pending");
    expect(appState.options.servers.stuns).toEqual([
      "stun:example",
    ]);
    fireEvent.click(
      group.getByRole("button", {
        name: "common.action.cancel",
      }),
    );
    expect(fields().stun.value).toBe("");
    expect(appState.options.servers.stuns).toEqual([
      "stun:example",
    ]);
  });

  it("respects IME composition and Escape cancels an inline edit", () => {
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    const input = fields().stun;
    fireEvent.click(
      screen.getByRole("button", {
        name: "setting.list.edit stun:example",
      }),
    );
    fireEvent.input(input, {
      target: { value: "stun:pending" },
    });
    fireEvent.keyDown(input, {
      key: "Enter",
      isComposing: true,
    });
    expect(appState.options.servers.stuns).toEqual([
      "stun:example",
    ]);
    expect(input.value).toBe("stun:pending");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("");
    expect(appState.options.servers.stuns).toEqual([
      "stun:example",
    ]);
  });

  it("preserves a pending edit when another tag is removed and allows cancelling on touch devices", () => {
    setAppState("options", "servers", "stuns", [
      "stun:first",
      "stun:second",
    ]);
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    const input = fields().stun;
    fireEvent.click(
      screen.getByRole("button", {
        name: "setting.list.edit stun:second",
      }),
    );
    fireEvent.input(input, {
      target: { value: "stun:edited" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "setting.list.remove stun:first",
      }),
    );
    expect(input.value).toBe("stun:edited");
    expect(input).toHaveFocus();
    expect(appState.options.servers.stuns).toEqual([
      "stun:second",
    ]);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(appState.options.servers.stuns).toEqual([
      "stun:edited",
    ]);
    fireEvent.click(
      screen.getByRole("button", {
        name: "setting.list.edit stun:edited",
      }),
    );
    fireEvent.input(input, {
      target: { value: "stun:discard" },
    });
    fireEvent.click(
      within(input.closest('[role="group"]')!).getByRole(
        "button",
        { name: "common.action.cancel" },
      ),
    );
    expect(input.value).toBe("");
    expect(appState.options.servers.stuns).toEqual([
      "stun:edited",
    ]);
    fireEvent.input(input, {
      target: { value: "stun:new" },
    });
    fireEvent.click(
      screen.getByRole("button", {
        name: "setting.list.remove stun:edited",
      }),
    );
    expect(input.value).toBe("stun:new");
    fireEvent.click(
      within(input.closest('[role="group"]')!).getByRole(
        "button",
        { name: "setting.list.add" },
      ),
    );
    expect(appState.options.servers.stuns).toEqual([
      "stun:new",
    ]);
  });

  it("can clear the list through bulk editing", () => {
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    const group = within(
      fields().turn.closest('[role="group"]')!,
    );
    fireEvent.click(
      group.getByRole("button", {
        name: "setting.list.bulk_edit",
      }),
    );
    fireEvent.input(fields().turn, {
      target: { value: "  \n" },
    });
    fireEvent.click(
      group.getByRole("button", {
        name: "setting.list.save",
      }),
    );
    expect(appState.options.servers.turns).toEqual([]);
    expect(
      group.queryByRole("button", {
        name: "common.action.check_availability",
      }),
    ).toBeNull();
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
    for (const field of Object.values(fields())) {
      expect(
        within(
          field.closest('[role="group"]')!,
        ).queryByRole("button", {
          name: "common.action.check_availability",
        }),
      ).toBeNull();
    }
  });

  it("keeps server sharing in connection settings and auto-join in application settings", () => {
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    expect(
      screen.queryByRole("switch", {
        name: "setting.connection.auto_join.title",
      }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("switch", {
        name: "setting.connection.share_servers_with_others.title",
      }),
    );
    expect(appState.options.shareServersWithOthers).toBe(
      true,
    );

    render(() => (
      <SettingsStateProvider>
        <ApplicationSettings />
      </SettingsStateProvider>
    ));
    const autoJoin = screen.getByRole("switch", {
      name: "setting.connection.auto_join.title",
    });
    fireEvent.click(autoJoin);
    expect(appState.profile.autoJoin).toBe(true);
    setAppState("profile", "initalJoin", true);
    expect(autoJoin).toBeDisabled();
  });

  it("resets server lists to deployment defaults", () => {
    vi.stubEnv("WEBLINK_STUN_SERVERS", "stun:default");
    vi.stubEnv(
      "VITE_TURN_SERVERS",
      "turn:default|user|password|longterm",
    );
    render(() => (
      <ConnectionSettings diagnostics={diagnostics} />
    ));
    const initial = fields();
    fireEvent.input(initial.stun, {
      target: { value: "stun:unsaved" },
    });
    fireEvent.click(
      within(
        initial.turn.closest('[role="group"]')!,
      ).getByRole("button", {
        name: "setting.list.bulk_edit",
      }),
    );
    fireEvent.input(fields().turn, {
      target: { value: "invalid" },
    });
    const { stun, turn } = fields();
    fireEvent.click(
      within(stun.closest('[role="group"]')!).getByRole(
        "button",
        {
          name: "common.action.reset",
        },
      ),
    );
    fireEvent.click(
      within(turn.closest('[role="group"]')!).getByRole(
        "button",
        {
          name: "common.action.reset",
        },
      ),
    );
    expect(fields().stun.value).toBe("");
    expect(fields().turn.value).toBe(
      "turn:default|user|password|longterm",
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
