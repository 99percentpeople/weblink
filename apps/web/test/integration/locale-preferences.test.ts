// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { createRoot } from "solid-js";
import { STORAGE_KEYS } from "@/constants";
import { appState } from "@/libs/state/app-state";
import {
  initializeAppOptions,
  setAppOptions,
} from "@/options";

vi.mock("@/i18n", () => ({ t: (key: string) => key }));

it("keeps a saved manual language and persists the system choice without resolving it", () => {
  localStorage.setItem(
    STORAGE_KEYS.appOptions,
    JSON.stringify({ locale: "fr-fr" }),
  );
  const dispose = createRoot((dispose) => {
    initializeAppOptions();
    return dispose;
  });
  try {
    expect(appState.options.locale).toBe("fr-fr");
    setAppOptions("locale", "system");
    expect(
      JSON.parse(
        localStorage.getItem(STORAGE_KEYS.appOptions)!,
      ).locale,
    ).toBe("system");
  } finally {
    dispose();
    localStorage.clear();
  }
});
