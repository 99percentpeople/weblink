import {
  SettingSlider,
  SettingSwitch,
} from "./setting-controls";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { resolveRemoteGamepadOptions } from "@/libs/domain/remote-control/gamepad-options";

export default function RemoteGamepadSettings() {
  const options = () =>
    resolveRemoteGamepadOptions(
      appState.options.remoteGamepad,
    );
  const prefix = "setting.remote_control.gamepad.";
  return (
    <>
      <SettingSwitch
        checked={options().enabled}
        onChange={(value) =>
          setAppOptions("remoteGamepad", "enabled", value)
        }
        label={t(`${prefix}title`)}
        description={t(`${prefix}description`)}
      />
      <SettingSwitch
        checked={options().vibration}
        disabled={!options().enabled}
        onChange={(value) =>
          setAppOptions("remoteGamepad", "vibration", value)
        }
        label={t(`${prefix}vibration`)}
        description={t(`${prefix}vibration_description`)}
      />
      <SettingSlider
        minValue={0}
        maxValue={1}
        step={0.05}
        value={[options().vibrationStrength]}
        disabled={
          !options().enabled || !options().vibration
        }
        onChange={(value) =>
          setAppOptions(
            "remoteGamepad",
            "vibrationStrength",
            value[0],
          )
        }
        getValueLabel={({ values }) =>
          `${Math.round(values[0] * 100)}%`
        }
        label={t(`${prefix}strength`)}
      />
      <SettingSlider
        minValue={0}
        maxValue={0.5}
        step={0.01}
        value={[options().deadZone]}
        disabled={!options().enabled}
        onChange={(value) =>
          setAppOptions(
            "remoteGamepad",
            "deadZone",
            value[0],
          )
        }
        getValueLabel={({ values }) =>
          `${Math.round(values[0] * 100)}%`
        }
        label={t(`${prefix}dead_zone`)}
        description={t(`${prefix}dead_zone_description`)}
      />
    </>
  );
}
