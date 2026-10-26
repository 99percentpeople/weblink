// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@solidjs/testing-library";
import { isDictLoaded, t } from "@/i18n";
import { setAppState } from "@/libs/state/app-state";

vi.mock("@/options", () => ({ setAppOptions: vi.fn() }));
vi.mock("@/assets/i18n/fr-fr.json", () => ({
  default: {
    common: {
      loading: "",
      no_results_found: " \t\n ",
      action: { close: "Fermer" },
    },
  },
}));

afterEach(() => setAppState("options", "locale", "en-us"));

it("uses English for missing or blank entries while preserving translated siblings", async () => {
  setAppState("options", "locale", "fr-fr");
  await waitFor(() => expect(isDictLoaded()).toBe(true));
  expect(t("common.loading")).toBe("Loading...");
  expect(t("common.no_results_found")).toBe(
    "No results found",
  );
  expect(
    t("common.forward_dialog.select_client", {
      name: "Alex",
    }),
  ).toBe("Select Alex");
  expect(t("common.action.close")).toBe("Fermer");
  expect(
    t("common.forward_dialog.select_client", {
      name: null,
    }),
  ).toBe("Select ");
  expect(t("missing.translation")).toBe(
    "missing.translation",
  );
  expect(t("common.action")).toBe("common.action");
});
