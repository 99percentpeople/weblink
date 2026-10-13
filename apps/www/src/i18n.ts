import {
  localeOptions,
  localeOptionsMap,
  normalizeLocalePreference,
  resolveLocale,
  type Locale,
} from "@weblink/locale";
import { setupDropdown } from "./dropdown";
import { catalogs, type MessageKey } from "./locales";

export interface I18n {
  t(
    key: MessageKey,
    values?: Record<string, string>,
  ): string;
  onChange(listener: () => void): void;
}

const storageKey = "www-locale";
const attributes = [
  "aria-label",
  "aria-roledescription",
  "alt",
  "content",
  "title",
] as const;

function readPreference(): Locale {
  try {
    return normalizeLocalePreference(
      localStorage.getItem(storageKey),
    );
  } catch {
    return "system";
  }
}

export function setupLanguage(signal: AbortSignal): I18n {
  let preference = readPreference();
  let locale = resolveLocale(
    preference,
    navigator.languages,
  );
  const listeners = new Set<() => void>();
  const i18n: I18n = {
    t(key, values = {}) {
      return catalogs[locale][key].replace(
        /\{(\w+)\}/g,
        (match, name: string) => values[name] ?? match,
      );
    },
    onChange(listener) {
      listeners.add(listener);
    },
  };
  const container = document.querySelector<HTMLElement>(
    "[data-locale-menu]",
  );
  const dropdown = container
    ? setupDropdown(container, signal, {
        id: "language",
        onChange(value) {
          preference = normalizeLocalePreference(value);
          try {
            localStorage.setItem(storageKey, preference);
          } catch {
            // Keep the in-memory choice when storage is unavailable.
          }
          apply();
        },
      })
    : undefined;

  const apply = (): void => {
    locale = resolveLocale(preference, navigator.languages);
    document.documentElement.lang = new Intl.Locale(
      locale,
    ).toString();
    document
      .querySelector('meta[property="og:locale"]')
      ?.setAttribute(
        "content",
        document.documentElement.lang.replace("-", "_"),
      );
    // Translate individual text nodes so icons, links, open FAQs and carousel state survive.
    // Query again to include the seamless carousel's copy after initialization.
    for (const element of document.querySelectorAll<HTMLElement>(
      "[data-i18n]",
    )) {
      const key = element.dataset.i18n;
      if (key && key in catalogs[locale])
        element.textContent = i18n.t(key as MessageKey);
    }
    for (const attribute of attributes) {
      for (const element of document.querySelectorAll<HTMLElement>(
        `[data-i18n-${attribute}]`,
      )) {
        const key = element.getAttribute(
          `data-i18n-${attribute}`,
        );
        if (key && key in catalogs[locale])
          element.setAttribute(
            attribute,
            i18n.t(key as MessageKey),
          );
      }
    }
    const name =
      preference === "system"
        ? i18n.t("theme.system")
        : localeOptionsMap[preference];
    dropdown?.update({
      value: preference,
      label: i18n.t("language.current", { language: name }),
      icon: "globe",
      options: localeOptions.map((value) => ({
        value,
        label:
          value === "system"
            ? i18n.t("theme.system")
            : localeOptionsMap[value],
        lang: value === "system" ? undefined : value,
      })),
    });
    for (const listener of listeners) listener();
  };
  window.addEventListener(
    "languagechange",
    () => {
      if (preference === "system") apply();
    },
    { signal },
  );
  window.addEventListener(
    "storage",
    (event) => {
      if (event.key !== storageKey && event.key !== null)
        return;
      preference = readPreference();
      apply();
    },
    { signal },
  );
  signal.addEventListener(
    "abort",
    () => listeners.clear(),
    { once: true },
  );
  apply();
  return i18n;
}
