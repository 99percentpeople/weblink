import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import { ThemeToggle } from "@/components/common/theme-toggle";
import { Label } from "@/components/ui/label";
import { LocaleSelector, t } from "@/i18n";
import { setAppOptions } from "@/options";
import WallpaperPicker from "./wallpaper-picker";

import { appState } from "@/libs/state/app-state";

export default function AppearanceSettings() {
  return (
    <section class="settings-section">
      <h3 id="appearance" class="h3">
        {t("setting.appearance.title")}
      </h3>

      <label class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <Label>
            {t("setting.appearance.theme.title")}
          </Label>

          <div class="ml-auto">
            <ThemeToggle />
          </div>
        </div>
        <p class="muted">
          {t("setting.appearance.theme.description")}
        </p>
      </label>

      <label class="flex flex-col gap-2">
        <Label>
          {t("setting.appearance.language.title")}
        </Label>
        <LocaleSelector />
        <p class="muted">
          {t("setting.appearance.language.description")}
        </p>
      </label>

      <WallpaperPicker />

      <div class="flex flex-col gap-2">
        <Switch
          class="flex items-center justify-between"
          checked={appState.options.wakeLock}
          onChange={(isChecked) =>
            setAppOptions("wakeLock", isChecked)
          }
        >
          <SwitchLabel>
            {t("setting.appearance.wake_lock.title")}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t("setting.appearance.wake_lock.description")}
        </p>
      </div>
    </section>
  );
}
