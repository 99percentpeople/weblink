import { Show } from "solid-js";
import type {
  NativeColorMatrix,
  NativeColorRange,
} from "@weblink/platform";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { appState } from "@/libs/state/app-state";
import { nativeScreenOptions } from "@/libs/application/meeting-video-settings";
import { setAppOptions } from "@/options";
import { t } from "@/i18n";

export default function NativeColorSettings() {
  const label = (key: string) =>
    t(`setting.meeting_settings.${key}`);
  const selected = () =>
    nativeScreenOptions(appState.options);
  const vp8 = () =>
    appState.options.nativeScreenCodec === "video/vp8";
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
      <div class="flex flex-col gap-2">
        <Label>{label("color_matrix")}</Label>
        <Select<NativeColorMatrix>
          modal
          value={selected().colorMatrix}
          disabled={vp8()}
          options={["auto", "bt709", "bt601"]}
          onChange={(value) =>
            value &&
            setAppOptions("nativeColorMatrix", value)
          }
          itemComponent={(item) => (
            <SelectItem item={item.item}>
              {matrixLabel(item.item.rawValue)}
            </SelectItem>
          )}
        >
          <SelectTrigger aria-label={label("color_matrix")}>
            <SelectValue<NativeColorMatrix>>
              {(state) =>
                matrixLabel(state.selectedOption())
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
      </div>
      <div class="flex flex-col gap-2">
        <Label>{label("color_range")}</Label>
        <Select<NativeColorRange>
          modal
          value={selected().colorRange}
          disabled={vp8()}
          options={["limited", "full"]}
          onChange={(value) =>
            value &&
            setAppOptions("nativeColorRange", value)
          }
          itemComponent={(item) => (
            <SelectItem item={item.item}>
              {rangeLabel(item.item.rawValue)}
            </SelectItem>
          )}
        >
          <SelectTrigger aria-label={label("color_range")}>
            <SelectValue<NativeColorRange>>
              {(state) =>
                rangeLabel(state.selectedOption())
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
        <p class="muted">{label("color_description")}</p>
        <Show when={vp8()}>
          <p class="muted">{label("color_vp8")}</p>
        </Show>
      </div>
      <div class="flex flex-col gap-2">
        <Label>{label("color_format")}</Label>
        <p>YUV 4:2:0 · 8-bit · SDR</p>
        <p class="muted">
          {label("color_hdr_unavailable")}
        </p>
      </div>
    </>
  );
}
