import { Show } from "solid-js";
import type {
  NativeColorFormat,
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
import {
  nativeColorFormats,
  nativeScreenOptions,
} from "@/libs/application/meeting-video-settings";
import { setAppOptions } from "@/options";
import { t } from "@/i18n";

export default function NativeColorSettings() {
  const label = (key: string) =>
    t(`setting.meeting_settings.${key}`);
  const selected = () =>
    nativeScreenOptions(appState.options);
  const vp8 = () => selected().codec === "video/vp8";
  const rgb = () => selected().colorFormat === "rgb";
  const formats = () =>
    nativeColorFormats(appState.options);
  const formatLabel = (value: NativeColorFormat) =>
    ({
      yuv420: "YUV 4:2:0",
      yuv444: "YUV 4:4:4",
      rgb: "RGB",
    })[value] + " · 8-bit · SDR";
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
        <Label>{label("color_format")}</Label>
        <Select<NativeColorFormat>
          modal
          value={selected().colorFormat}
          options={formats()}
          disabled={formats().length === 1}
          onChange={(value) =>
            value &&
            formats().includes(value) &&
            setAppOptions("nativeColorFormat", value)
          }
          itemComponent={(item) => (
            <SelectItem item={item.item}>
              {formatLabel(item.item.rawValue)}
            </SelectItem>
          )}
        >
          <SelectTrigger aria-label={label("color_format")}>
            <SelectValue<NativeColorFormat>>
              {(state) =>
                formatLabel(state.selectedOption())
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
        <Show when={selected().colorFormat !== "yuv420"}>
          <p class="muted">{label("color_full_chroma")}</p>
        </Show>
      </div>
      <div class="flex flex-col gap-2">
        <Label>{label("color_matrix")}</Label>
        <Select<NativeColorMatrix>
          modal
          value={selected().colorMatrix}
          disabled={vp8() || rgb()}
          options={
            vp8() ? ["bt601"] : ["auto", "bt709", "bt601"]
          }
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
                rgb()
                  ? "RGB"
                  : matrixLabel(state.selectedOption())
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
          disabled={
            vp8() || selected().colorFormat !== "yuv420"
          }
          options={
            vp8()
              ? ["limited"]
              : selected().colorFormat !== "yuv420"
                ? ["full"]
                : ["limited", "full"]
          }
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
    </>
  );
}
