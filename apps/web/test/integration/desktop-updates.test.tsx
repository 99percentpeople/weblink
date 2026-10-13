// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
} from "@solidjs/testing-library";
import { createSignal } from "solid-js";
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
