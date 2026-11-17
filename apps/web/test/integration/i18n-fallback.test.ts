// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { waitFor } from "@solidjs/testing-library";
import { createMemo, createRoot } from "solid-js";
import { isDictLoaded, t } from "@/i18n";
import { setAppState } from "@/libs/state/app-state";
import { formatVideoStatisticsGroups } from "@/routes/home/components/video-statistics-groups";

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

it("updates existing statistics labels when the Chinese dictionary loads", async () => {
  setAppState("options", "locale", "en-us");
  const view = createRoot((dispose) => ({
    dispose,
    metric: createMemo(() =>
      formatVideoStatisticsGroups([
        { direction: "receive", peer: "Alice" },
        {
          direction: "display",
          captureToReceiveMs: 55,
          receiveToPresentMs: 25,
        },
      ])[0].summary.find(
        (metric) => metric.key === "captureToReceiveMs",
      ),
    ),
  }));
  try {
    await waitFor(() =>
      expect(view.metric()?.label).toBe("Receive latency"),
    );
    for (const [locale, label] of [
      ["zh-cn", "接收延迟"],
      ["zh-tw", "接收延遲"],
    ] as const) {
      setAppState("options", "locale", locale);
      await waitFor(() =>
        expect(view.metric()?.label).toBe(label),
      );
      expect(view.metric()?.description).toBe(
        t(
          "video.statistics.capture_to_receive_description",
        ),
      );
    }
  } finally {
    view.dispose();
  }
});
