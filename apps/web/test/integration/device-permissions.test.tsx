// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
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
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("locks every device permission until code-confirmed pairing, then leaves all grants off", async () => {
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
    setClientConfig("peer", {
      receiveContent: false,
      shareScreen: false,
      provideFileList: false,
      remoteControl: "deny",
    });
    setTrust({ ...trust(), state: "trusted" });
  });
  render(() => <ClientPermissions clientId="peer" />);
  for (const control of screen.getAllByRole("switch")) {
    expect(control).toBeDisabled();
    expect(control).not.toBeChecked();
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
  for (const control of screen.getAllByRole("switch")) {
    expect(control).toBeEnabled();
    expect(control).not.toBeChecked();
  }
  const receive = screen.getByRole("switch", {
    name: "device_trust.receive_content",
  });
  fireEvent.click(receive);
  expect(
    appState.options.clientConfigs.peer?.receiveContent,
  ).toBe(true);
  expect(
    appState.options.clientConfigs.peer?.shareScreen,
  ).toBe(false);
  setTrust({ state: "untrusted" });
  expect(receive).toBeDisabled();
  expect(receive).not.toBeChecked();
  expect(
    screen.queryByRole("button", {
      name: "device_trust.repair",
    }),
  ).not.toBeInTheDocument();
});
