import { SettingRow } from "./setting-layout";
import { SettingSelect } from "./setting-controls";
import { Show } from "solid-js";
import type {
  NativeColorMatrix,
  NativeColorRange,
} from "@weblink/platform";

import { appState } from "@/libs/state/app-state";
import { nativeScreenOptions } from "@/libs/application/meeting-video-settings";
import { setAppOptions } from "@/options";
import { t } from "@/i18n";

export default function NativeColorSettings() {
  const label = (key: string) =>
    t(`setting.meeting_settings.${key}`);
  const selected = () =>
    nativeScreenOptions(appState.options);
  const vp8 = () => selected().codec === "video/vp8";
  const matrixLabel = (value: NativeColorMatrix) =>
    value === "auto"
      ? label("color_auto")
      : value === "bt709"
        ? "BT.709"
        : "BT.601";
  const rangeLabel = (value: NativeColorRange) =>
    label(`color_range_${value}`);
  return (
    <>
      <SettingRow label={label("color_format")}>
        <span class="text-sm">YUV 4:2:0 · 8-bit · SDR</span>
      </SettingRow>
      <SettingSelect<NativeColorMatrix>
        modal
        value={selected().colorMatrix}
        disabled={vp8()}
        options={
          vp8() ? ["bt601"] : ["auto", "bt709", "bt601"]
        }
        onChange={(value) =>
          value &&
          !vp8() &&
          setAppOptions("nativeColorMatrix", value)
        }
        label={label("color_matrix")}
        optionLabel={(option) => matrixLabel(option)}
      />
      <SettingSelect<NativeColorRange>
        modal
        value={selected().colorRange}
        disabled={vp8()}
        options={vp8() ? ["limited"] : ["limited", "full"]}
        onChange={(value) =>
          value &&
          !vp8() &&
          setAppOptions("nativeColorRange", value)
        }
        label={label("color_range")}
        description={label("color_description")}
        hint={
          <>
            <Show when={vp8()}>
              <p class="muted">{label("color_vp8")}</p>
            </Show>
          </>
        }
        optionLabel={(option) => rangeLabel(option)}
      />
    </>
  );
}
