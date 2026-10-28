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
import type {
  NativeUpdateProgress,
  NativeUpdates,
} from "@weblink/platform";
import { DesktopUpdates } from "@/components/settings/desktop-updates";
import { createAppUpdates } from "@/libs/state/create-app-updates";
import { resolveStoredAppOptions } from "@/libs/state/stored-app-options";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));
afterEach(cleanup);

it("exposes the startup switch and routes portable downloads without offering install", async () => {
  const native = {
    check: vi.fn().mockResolvedValue({
      status: "available",
      update: {
        version: "1.2.0",
        notes: "Notes",
        canInstall: false,
        downloadKind: "portable",
        downloadUrl: "https://example.com/portable.zip",
      },
    }),
    install: vi.fn(),
  };
  const changed = vi.fn();
  render(() => {
    const updates = createAppUpdates(native);
    const [automatic, setAutomatic] = createSignal(true);
    return (
      <DesktopUpdates
        updates={updates}
        automatic={automatic()}
        onAutomaticChange={(enabled) => {
          changed(enabled);
          setAutomatic(enabled);
        }}
      />
    );
  });
  fireEvent.click(
    screen.getByRole("switch", {
      name: "setting.updates.automatic",
    }),
  );
  expect(changed).toHaveBeenCalledWith(false);
  fireEvent.click(
    screen.getByRole("button", {
      name: "setting.updates.check",
    }),
  );
  expect(
    await screen.findByRole("link", {
      name: "setting.updates.download_portable",
    }),
  ).toHaveAttribute(
    "href",
    "https://example.com/portable.zip",
  );
  expect(
    screen.queryByRole("button", {
      name: "setting.updates.install",
    }),
  ).not.toBeInTheDocument();
  expect(native.install).not.toHaveBeenCalled();
});

it("preserves a disabled startup check and migrates old settings to the default", () => {
  expect(
    resolveStoredAppOptions({ autoCheckUpdates: false })
      .autoCheckUpdates,
  ).toBe(false);
  expect(resolveStoredAppOptions({}).autoCheckUpdates).toBe(
    true,
  );
  expect(
    resolveStoredAppOptions({ autoCheckUpdates: "false" })
      .autoCheckUpdates,
  ).toBe(true);
});

it("shows indeterminate progress while preparing, reports download progress, and resets after failure", async () => {
  let onProgress!: (value: NativeUpdateProgress) => void;
  let failInstall!: (error: Error) => void;
  const native: NativeUpdates = {
    check: vi.fn().mockResolvedValue({
      status: "available",
      update: {
        version: "1.2.0",
        notes: null,
        canInstall: true,
        downloadKind: "installer",
        downloadUrl: "https://example.com/setup.exe",
      },
    }),
    install: vi.fn((_version, receive) => {
      onProgress = receive;
      return new Promise<void>((_resolve, reject) => {
        failInstall = reject;
      });
    }),
  };
  render(() => (
    <DesktopUpdates
      updates={createAppUpdates(native)}
      automatic={true}
      onAutomaticChange={() => {}}
    />
  ));
  const check = screen.getByRole("button", {
    name: "setting.updates.check",
  });
  fireEvent.click(check);
  expect(check).toBeDisabled();
  expect(
    screen.getByText("setting.updates.checking"),
  ).toBeInTheDocument();
  const install = await screen.findByRole("button", {
    name: "setting.updates.install",
  });
  fireEvent.click(install);
  expect(check).toBeDisabled();
  expect(install).toBeDisabled();
  const ring = screen.getByRole("progressbar", {
    name: "setting.updates.downloading",
  });
  expect(ring).not.toHaveAttribute("aria-valuenow");
  expect(screen.queryByText(/^\d+%$/)).toBeNull();

  for (const total of [null, 0]) {
    onProgress({
      phase: "downloading",
      downloaded: 50,
      total,
    });
    expect(ring).not.toHaveAttribute("aria-valuenow");
    expect(screen.queryByText(/^\d+%$/)).toBeNull();
  }
  for (const downloaded of [0, 50, 100]) {
    onProgress({
      phase: "downloading",
      downloaded,
      total: 100,
    });
    expect(ring).toHaveAttribute(
      "aria-valuenow",
      String(downloaded),
    );
    expect(
      screen.getByText(`${downloaded}%`),
    ).toBeInTheDocument();
  }
  onProgress({
    phase: "installing",
    downloaded: 100,
    total: 100,
  });
  expect(
    screen.getByRole("progressbar", {
      name: "setting.updates.installing",
    }),
  ).toBe(ring);
  expect(ring).not.toHaveAttribute("aria-valuenow");
  expect(screen.queryByText(/^\d+%$/)).toBeNull();

  failInstall(new Error("Installer failed"));
  await waitFor(() =>
    expect(screen.getByRole("alert")).toHaveTextContent(
      "setting.updates.install_failed",
    ),
  );
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(check).not.toBeDisabled();
  expect(install).not.toBeDisabled();

  fireEvent.click(install);
  expect(native.install).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(
    screen.getByRole("progressbar"),
  ).not.toHaveAttribute("aria-valuenow");
  expect(screen.queryByText(/^\d+%$/)).toBeNull();
  failInstall(new Error("Retry failed"));
  await screen.findByRole("alert");
});
