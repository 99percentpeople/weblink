// @vitest-environment jsdom
import {
  afterEach,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { setAppState } from "@/libs/state/app-state";
import type { ClientInfo } from "@/libs/state/app-state";
import { DeviceTrustToasts } from "@/components/app/device-trust-toasts";
import { OPEN_CLIENT_INFO_DIALOG_EVENT } from "@/components/dialogs/client-info-dialog-events";

const fixture = vi.hoisted(() => ({
  warning: vi.fn(
    (
      _title: string,
      options: {
        id: string;
        action: { onClick(): void };
      },
    ) => options.id,
  ),
  dismiss: vi.fn(),
}));
vi.mock("solid-sonner", () => ({
  toast: {
    warning: fixture.warning,
    dismiss: fixture.dismiss,
  },
}));
vi.mock("@/i18n", () => ({
  t: (key: string) => key,
}));
const openPeer = vi.fn();
const client = (
  id: string,
  trust: ClientInfo["trust"] = "untrusted",
): ClientInfo => ({
  clientId: id,
  name: id,
  avatar: "",
  createdAt: 0,
  onlineStatus: "online",
  messageChannel: true,
  trust,
});
const show = (...peers: ClientInfo[]) =>
  setAppState(
    "session",
    "clientViewData",
    Object.fromEntries(
      peers.map((peer) => [peer.clientId, peer]),
    ),
  );
const action = (
  index = fixture.warning.mock.calls.length - 1,
) => fixture.warning.mock.calls[index][1].action.onClick;
beforeEach(() => {
  vi.clearAllMocks();
  setAppState("session", "clientViewData", {});
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
  for (const id of ["a", "b"])
    setAppState(
      "session",
      "clientViewData",
      id,
      undefined!,
    );
});

it("warns for untrusted connections and opens that device's permission settings", () => {
  render(() => <DeviceTrustToasts />);
  show(client("a", "verifying"), client("b", "trusted"));
  expect(fixture.warning).not.toHaveBeenCalled();
  setAppState(
    "session",
    "clientViewData",
    "a",
    "trust",
    "untrusted",
  );
  expect(fixture.warning).toHaveBeenCalledOnce();
  action()();
  expect(
    (openPeer.mock.calls[0][0] as CustomEvent).detail,
  ).toEqual({
    clientId: "a",
    tab: "settings",
  });
});

it("deduplicates state updates and identity retries, and dismisses on repair", () => {
  render(() => <DeviceTrustToasts />);
  show(client("a"));
  const stale = action();
  setAppState(
    "session",
    "clientViewData",
    "a",
    "name",
    "renamed",
  );
  setAppState(
    "session",
    "clientViewData",
    "a",
    "trust",
    "verifying",
  );
  stale();
  setAppState(
    "session",
    "clientViewData",
    "a",
    "trust",
    "untrusted",
  );
  expect(fixture.warning).toHaveBeenCalledOnce();
  setAppState(
    "session",
    "clientViewData",
    "a",
    "trust",
    "trusted",
  );
  expect(fixture.dismiss).toHaveBeenCalledWith(
    "device-trust:a",
  );
  stale();
  expect(openPeer).not.toHaveBeenCalled();
});

it("dismisses disconnected devices, rejects old actions after reconnect, and cleans up", () => {
  const view = render(() => <DeviceTrustToasts />);
  show(client("a"), client("b"));
  const stale = action(0);
  setAppState(
    "session",
    "clientViewData",
    "a",
    "messageChannel",
    false,
  );
  expect(fixture.dismiss).toHaveBeenCalledWith(
    "device-trust:a",
  );
  stale();
  setAppState(
    "session",
    "clientViewData",
    "a",
    "messageChannel",
    true,
  );
  expect(fixture.warning).toHaveBeenCalledTimes(3);
  stale();
  expect(openPeer).not.toHaveBeenCalled();
  action()();
  expect(
    (openPeer.mock.calls[0][0] as CustomEvent).detail
      .clientId,
  ).toBe("a");
  view.unmount();
  expect(fixture.dismiss).toHaveBeenCalledWith(
    "device-trust:b",
  );
  action()();
  expect(openPeer).toHaveBeenCalledOnce();
});

it("does not notify for ordinary connection loss or a pending first verification", () => {
  render(() => <DeviceTrustToasts />);
  show(client("a", "trusted"), client("b", "verifying"));
  setAppState(
    "session",
    "clientViewData",
    "a",
    "trust",
    "verifying",
  );
  setAppState(
    "session",
    "clientViewData",
    "a",
    "messageChannel",
    false,
  );
  setAppState(
    "session",
    "clientViewData",
    "b",
    "messageChannel",
    false,
  );
  setAppState(
    "session",
    "clientViewData",
    "b",
    "trust",
    "untrusted",
  );
  expect(fixture.warning).not.toHaveBeenCalled();
});
