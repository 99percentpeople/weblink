import { setupDropdown } from "./dropdown";
import type { I18n } from "./i18n";

type ThemePreference = "system" | "light" | "dark";

const storageKey = "www-theme";

function readPreference(): ThemePreference {
  try {
    const value = localStorage.getItem(storageKey);
    return value === "light" || value === "dark"
      ? value
      : "system";
  } catch {
    return "system";
  }
}

export function setupTheme(
  signal: AbortSignal,
  i18n: I18n,
): void {
  const root = document.documentElement;
  const system = window.matchMedia(
    "(prefers-color-scheme: dark)",
  );
  let preference = readPreference();
  const container = document.querySelector<HTMLElement>(
    "[data-theme-menu]",
  );
  const dropdown = container
    ? setupDropdown(container, signal, {
        id: "theme",
        onChange(value) {
          if (
            value !== "system" &&
            value !== "light" &&
            value !== "dark"
          )
            return;
          preference = value;
          try {
            localStorage.setItem(storageKey, preference);
          } catch {
            // Keep the in-memory choice when storage is unavailable.
          }
          applyTheme();
        },
      })
    : undefined;

  const applyTheme = (): void => {
    const dark =
      preference === "system"
        ? system.matches
        : preference === "dark";
    root.classList.toggle("dark", dark);

    // Query each time so seamless carousel copies also follow the theme.
    for (const asset of document.querySelectorAll<HTMLElement>(
      "[data-theme-light][data-theme-dark]",
    )) {
      const url = dark
        ? asset.dataset.themeDark
        : asset.dataset.themeLight;
      if (!url) continue;
      const attribute =
        asset instanceof HTMLImageElement ? "src" : "href";
      if (asset.getAttribute(attribute) !== url) {
        asset.setAttribute(attribute, url);
      }
    }

    dropdown?.update({
      value: preference,
      label: i18n.t("theme.current", {
        mode: i18n.t(`theme.${preference}`),
      }),
      icon: dark ? "moon" : "sun",
      options: (["system", "light", "dark"] as const).map(
        (value) => ({
          value,
          label: i18n.t(`theme.${value}`),
          icon:
            value === "system"
              ? "monitor"
              : value === "dark"
                ? "moon"
                : "sun",
        }),
      ),
    });
    document
      .querySelector<HTMLMetaElement>(
        'meta[name="theme-color"]',
      )
      ?.setAttribute(
        "content",
        getComputedStyle(root)
          .getPropertyValue("--background")
          .trim(),
      );
  };

  system.addEventListener(
    "change",
    () => {
      if (preference === "system") applyTheme();
    },
    { signal },
  );
  window.addEventListener(
    "storage",
    (event) => {
      if (event.key !== storageKey && event.key !== null)
        return;
      preference = readPreference();
      applyTheme();
    },
    { signal },
  );
  i18n.onChange(applyTheme);
  applyTheme();
}
