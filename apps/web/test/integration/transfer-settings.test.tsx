// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
} from "@solidjs/testing-library";
import userEvent from "@testing-library/user-event";
import { createRoot } from "solid-js";
import TransferSettings from "@/components/settings/transfer-settings";
import { STORAGE_KEYS } from "@/constants";
import { appState } from "@/libs/state/app-state";
import {
  forgetRoomConfig,
  initializeAppOptions,
  resetRoomConfig,
} from "@/options";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));

let dispose: (() => void) | undefined;
afterEach(() => {
  cleanup();
  dispose?.();
  localStorage.clear();
  vi.restoreAllMocks();
});

it("restores the global limit, persists edits and keeps it independent of room resets or deletion", async () => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
  const megabyte = 1024 * 1024;
  localStorage.setItem(
    STORAGE_KEYS.appOptions,
    JSON.stringify({
      maxConcurrentTransfers: 4,
      autoDownloadMaxSize: 2 * megabyte,
      roomConfigs: {
        first: {
          name: "First",
          autoDownloadFiles: true,
        },
        second: {
          name: "Second",
          autoDownloadFiles: true,
        },
      },
    }),
  );
  createRoot((cleanup) => {
    dispose = cleanup;
    initializeAppOptions();
  });
  const savedOptions = () =>
    JSON.parse(
      localStorage.getItem(STORAGE_KEYS.appOptions)!,
    );
  expect(savedOptions()).toMatchObject({
    maxConcurrentTransfers: 4,
    autoDownloadMaxSize: 2 * megabyte,
    roomConfigs: {
      first: { name: "First", autoDownloadFiles: true },
      second: { name: "Second", autoDownloadFiles: true },
    },
  });
  render(() => <TransferSettings />);
  const concurrency = screen.getByRole("slider", {
    name: /setting\.transfer_queue\.title/,
    value: { now: 4 },
  });
  expect(concurrency).toHaveAttribute("aria-valuenow", "4");
  concurrency.focus();
  await userEvent.keyboard("{ArrowRight}");
  await waitFor(() => {
    expect(appState.options.maxConcurrentTransfers).toBe(5);
    expect(savedOptions().maxConcurrentTransfers).toBe(5);
  });
  const limit = screen.getByRole("button", {
    name: /^setting\.receiver\.auto_download_limit\.title/,
  });
  expect(limit).toHaveTextContent("2 MB");
  await userEvent.click(limit);
  await userEvent.click(
    await screen.findByRole("option", { name: "10 MB" }),
  );
  await waitFor(() => {
    expect(appState.options.autoDownloadMaxSize).toBe(
      10 * megabyte,
    );
    expect(savedOptions().autoDownloadMaxSize).toBe(
      10 * megabyte,
    );
  });
  expect(
    appState.options.roomConfigs.first?.autoDownloadFiles,
  ).toBe(true);
  expect(
    appState.options.roomConfigs.second?.autoDownloadFiles,
  ).toBe(true);

  resetRoomConfig("first");
  forgetRoomConfig("second", undefined);
  expect(savedOptions().maxConcurrentTransfers).toBe(5);
  expect(savedOptions().autoDownloadMaxSize).toBe(
    10 * megabyte,
  );
  expect(savedOptions().roomConfigs).toEqual({
    first: { name: "First", autoDownloadFiles: false },
  });
});
