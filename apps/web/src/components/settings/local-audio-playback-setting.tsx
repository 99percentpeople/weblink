import { t } from "@/i18n";
import { supportsLocalAudioSuppression } from "@/libs/application/meeting-audio-settings";
import { platform } from "@/libs/platform/runtime";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { SettingSwitch } from "./setting-controls";

export default function LocalAudioPlaybackSetting() {
  const nativeSupported = () => {
    const runtime = appState.capabilities.runtime;
    return (
      runtime?.runtime === "desktop" &&
      runtime.nativeScreenCapture &&
      !!platform.screenShare
    );
  };
  const supported = () =>
    nativeSupported() || supportsLocalAudioSuppression();
  const label = (key: string) =>
    t(
      `setting.meeting_settings.audio.local_playback.${key}`,
    );
  return (
    <SettingSwitch
      label={label("title")}
      description={label(
        supported()
          ? nativeSupported()
            ? "desktop_description"
            : "browser_description"
          : "unsupported",
      )}
      disabled={!supported()}
      checked={appState.options.suppressLocalAudioPlayback}
      onChange={(value) =>
        setAppOptions("suppressLocalAudioPlayback", value)
      }
    />
  );
}
