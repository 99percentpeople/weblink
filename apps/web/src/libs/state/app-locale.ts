import {
  createEffect,
  createSignal,
  onCleanup,
} from "solid-js";
import { resolveLocale } from "@/libs/i18n/locale";
import { appState } from "./app-state";

function readSystemLanguages(): readonly string[] {
  if (typeof navigator === "undefined") return [];
  return navigator.languages?.length
    ? [...navigator.languages]
    : [navigator.language];
}

const [systemLanguages, setSystemLanguages] = createSignal(
  readSystemLanguages(),
);

/** A concrete language tag for dictionaries, Intl and native settings. */
export const resolvedLocale = () =>
  resolveLocale(appState.options.locale, systemLanguages());

/** The application owner controls the listener's lifetime, including HMR. */
export function initializeAppLocale(): void {
  const update = () =>
    setSystemLanguages(readSystemLanguages());
  update();
  const controller = new AbortController();
  window.addEventListener("languagechange", update, {
    signal: controller.signal,
  });
  onCleanup(() => controller.abort());
  createEffect(() => {
    document.documentElement.lang = resolvedLocale();
  });
}
