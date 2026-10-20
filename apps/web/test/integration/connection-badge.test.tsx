// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
} from "@solidjs/testing-library";
import { createStore } from "solid-js/store";
import { ConnectionBadge } from "@/components/common/connection-badge";
import type { ClientInfo } from "@/libs/state/app-state";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
afterEach(cleanup);

it("only reports identity verification after transport and message channel are ready", () => {
  const [client, setClient] = createStore({
    onlineStatus: "reconnecting",
    messageChannel: false,
    trust: "verifying",
  } as ClientInfo);
  render(() => <ConnectionBadge client={client} />);
  expect(
    screen.getByText("common.status.reconnecting"),
  ).toBeInTheDocument();
  setClient("onlineStatus", "online");
  expect(
    screen.getByText("common.status.connecting"),
  ).toBeInTheDocument();
  setClient("messageChannel", true);
  expect(
    screen.getByText("device_trust.verifying"),
  ).toBeInTheDocument();
  setClient("trust", "untrusted");
  expect(
    screen.getByText("device_trust.untrusted"),
  ).toBeInTheDocument();
  setClient("trust", "trusted");
  expect(
    screen.getByText("common.status.online"),
  ).toBeInTheDocument();
  setClient({
    onlineStatus: "offline",
    // Offline wins even before the old message channel is marked closed.
    messageChannel: true,
    trust: "verifying",
  });
  expect(
    screen.getByText("common.status.offline"),
  ).toBeInTheDocument();
  expect(
    screen.queryByText("device_trust.verifying"),
  ).not.toBeInTheDocument();
});
