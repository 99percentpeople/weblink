import { createEffect, onCleanup, onMount } from "solid-js";
import { toast } from "solid-sonner";
import { t } from "@/i18n";
import { platform } from "@/libs/platform/runtime";
import { createInitialization } from "@/libs/application/initialization";
import { createApplicationSettingsSync } from "@/libs/application/application-settings";
import { appState } from "./app-state";
import {
  initializeAppLocale,
  resolvedLocale,
} from "./app-locale";

/** Native integration and initialization follow the application scope, not a view. */
export function initializeApplication(): void {
  initializeAppLocale();
  onMount(() => {
    const dispose = platform.initialize();
    onCleanup(dispose);
  });
  void createInitialization(platform.getDeviceName).catch(
    (error) => {
      console.error(error);
      toast.error(error?.message ?? String(error));
    },
  );
  if (!platform.application) return;
  const settings = createApplicationSettingsSync(
    platform.application,
    (error) => {
      console.error(
        "Could not update native application settings",
        error,
      );
      toast.error(t("setting.application.update_failed"));
    },
  );
  createEffect(() => {
    const { closeBehavior, hideOnRemoteControl } =
      appState.options.application;
    const locale = resolvedLocale();
    settings.update({
      closeBehavior,
      hideOnRemoteControl,
      locale: locale === "en-us" ? "en" : locale,
    });
  });
  onCleanup(() => settings.close());
}
