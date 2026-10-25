import type {
  NativeEncoder,
  NativeEncodingPreset,
} from "@weblink/platform";
import { createMemo, Show } from "solid-js";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import {
  nativeEncodingPresets,
  resolveEncodingPreset,
  supportedEncodingPresets,
} from "@/libs/application/native-encoding-presets";
import { SettingSelect } from "./setting-controls";

export default function NativeEncodingPresetSettings(props: {
  encoders: readonly NativeEncoder[];
}) {
  const encoder = () =>
    appState.options.nativeScreenEncoder ?? "auto";
  const supported = createMemo(() =>
    supportedEncodingPresets(props.encoders, encoder()),
  );
  const selected = () =>
    resolveEncodingPreset(
      appState.options.nativeEncoderPresets?.[encoder()],
    );
  const label = (key: string) =>
    t(`setting.meeting_settings.encoding_preset_${key}`);
  return (
    <Show when={supported().length > 1}>
      <SettingSelect<NativeEncodingPreset>
        modal
        value={selected()}
        options={[...nativeEncodingPresets]}
        optionDisabled={(preset) =>
          !supported().includes(preset)
        }
        optionLabel={(preset) => label(preset)}
        label={label("label")}
        description={label("description")}
        hint={
          <Show
            when={
              encoder() === "auto" ||
              !supported().includes(selected())
            }
          >
            <p class="muted" role="status">
              {label("fallback")}
            </p>
          </Show>
        }
        onChange={(value) => {
          if (!value || !supported().includes(value))
            return;
          setAppOptions("nativeEncoderPresets", {
            ...appState.options.nativeEncoderPresets,
            [encoder()]: value,
          });
        }}
      />
    </Show>
  );
}
