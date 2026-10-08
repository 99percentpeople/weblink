import {
  SettingSection,
  SettingRow,
  SettingBlock,
} from "./setting-layout";
import {
  SettingSwitch,
  SettingSelect,
} from "./setting-controls";

import { ThemeToggle } from "@/components/common/theme-toggle";

import { t, localeLabel } from "@/i18n";
import { setAppOptions } from "@/options";
import {
  localeOptions,
  type Locale,
} from "@/libs/i18n/locale";
import WallpaperPicker from "./wallpaper-picker";

import { appState } from "@/libs/state/app-state";

export default function AppearanceSettings() {
  return (
    <SettingSection
      id="appearance"
      title={t("setting.appearance.title")}
    >
      <SettingRow
        layout="compact"
        label={t("setting.appearance.theme.title")}
        description={t(
          "setting.appearance.theme.description",
        )}
      >
        <ThemeToggle />
      </SettingRow>
      <SettingSelect<Locale>
        label={t("setting.appearance.language.title")}
        description={t(
          "setting.appearance.language.description",
        )}
        options={localeOptions}
        value={appState.options.locale}
        onChange={(value) => {
          if (value) setAppOptions("locale", value);
        }}
        optionLabel={localeLabel}
      />
      <SettingBlock>
        <WallpaperPicker />
      </SettingBlock>
      <SettingSwitch
        checked={appState.options.wakeLock}
        onChange={(isChecked) =>
          setAppOptions("wakeLock", isChecked)
        }
        label={t("setting.appearance.wake_lock.title")}
        description={t(
          "setting.appearance.wake_lock.description",
        )}
      />
    </SettingSection>
  );
}
