// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import {
  createSignal,
  type Accessor,
  type Setter,
} from "solid-js";
import type { Approval } from "@weblink/automation";
import { AutomationApprovalToasts } from "@/components/app/automation-approval-toasts";
import { OPEN_CLIENT_INFO_DIALOG_EVENT } from "@/components/dialogs/client-info-dialog-events";

const fixture = vi.hoisted(() => ({
  pending: undefined as Accessor<Approval[]> | undefined,
  notify: vi.fn(
    (
      _title: string,
      options: {
        id: string;
        action: { onClick: () => void };
      },
    ) => options.id,
  ),
  dismiss: vi.fn(),
  canReceive: vi.fn(),
}));
vi.mock("solid-sonner", () => ({
  toast: Object.assign(fixture.notify, {
    dismiss: fixture.dismiss,
  }),
}));
vi.mock("@/i18n", () => ({ t: (key: string) => key }));
vi.mock("@/libs/state/app-state-context", () => ({
  useAppState: () => ({
    automation: {
      snapshot: () => ({
        pending: fixture.pending?.() ?? [],
      }),
    },
  }),
}));

vi.mock("@/libs/application/session-service", () => ({
  sessionService: { canReceive: fixture.canReceive },
}));

let setPending: Setter<Approval[]>;
const openPeer = vi.fn();
const request = (
  kind: "peer" | "mcp" = "peer",
  id = "request",
): Approval => ({
  id,
  principal: {
    id: "paired-device",
    kind,
    label: "Device",
  },
  scope: "shell.execute",
  tool: "commands.start",
  arguments: { target: "local", script: "echo ok" },
  expiresAt: Date.now() + 120000,
});
const review = () =>
  fixture.notify.mock.calls.at(-1)![1].action.onClick;
beforeEach(() => {
  vi.clearAllMocks();
  [fixture.pending, setPending] = createSignal<Approval[]>(
    [],
  );
  fixture.canReceive.mockReturnValue(true);
  window.addEventListener(
    OPEN_CLIENT_INFO_DIALOG_EVENT,
    openPeer,
  );
});
afterEach(() => {
  cleanup();
  window.removeEventListener(
    OPEN_CLIENT_INFO_DIALOG_EVENT,
    openPeer,
  );
});
it("routes peer requests to verified device settings without prompting local MCP clients", () => {
  render(() => <AutomationApprovalToasts />);
  setPending([request()]);
  review()();
  expect(fixture.canReceive).toHaveBeenCalledWith(
    "paired-device",
  );
  expect(
    (openPeer.mock.calls[0][0] as CustomEvent).detail,
  ).toEqual({ clientId: "paired-device", tab: "settings" });
  setPending([request("mcp", "local")]);
  expect(fixture.notify).toHaveBeenCalledOnce();
  expect(fixture.dismiss).toHaveBeenCalledWith(
    "automation-approval:request",
  );
});
it("deduplicates snapshots and dismisses resolved requests and notifications on unmount", () => {
  const view = render(() => <AutomationApprovalToasts />);
  const pending = request();
  setPending([pending]);
  setPending([{ ...pending }]);
  expect(fixture.notify).toHaveBeenCalledOnce();
  setPending([]);
  expect(fixture.dismiss).toHaveBeenCalledWith(
    "automation-approval:request",
  );
  setPending([request("peer", "next")]);
  view.unmount();
  expect(fixture.dismiss).toHaveBeenCalledWith(
    "automation-approval:next",
  );
});
it("ignores stale, expired and disconnected peer actions using shared device access checks", () => {
  render(() => <AutomationApprovalToasts />);
  setPending([request()]);
  const stale = review();
  setPending([]);
  stale();
  setPending([{ ...request(), expiresAt: Date.now() - 1 }]);
  review()();
  setPending([request("peer", "disconnected")]);
  fixture.canReceive.mockReturnValue(false);
  review()();
  expect(openPeer).not.toHaveBeenCalled();
});
