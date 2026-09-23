import { Show } from "solid-js";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";

import {
  Slider,
  SliderFill,
  SliderLabel,
  SliderThumb,
  SliderTrack,
  SliderValueLabel,
} from "@/components/ui/slider";

import { t } from "@/i18n";
import { setAppOptions, CompressionLevel } from "@/options";

import { appState } from "@/libs/state/app-state";

export default function TransferSettings() {
  return (
    <section class="settings-section">
      <h3 id="sender" class="h3">
        {t("setting.sender.title")}
      </h3>
      <div class="flex flex-col gap-2">
        <Switch
          disabled={!navigator.clipboard}
          class="flex items-center justify-between"
          checked={appState.options.enableClipboard}
          onChange={(isChecked) =>
            setAppOptions("enableClipboard", isChecked)
          }
        >
          <SwitchLabel>
            {t("setting.sender.enable_clipboard.title")}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t("setting.sender.enable_clipboard.description")}
        </p>
        <Show when={!navigator.clipboard}>
          <p class="text-destructive-foreground text-xs">
            {t(
              "setting.sender.enable_clipboard.unsupported",
            )}
          </p>
        </Show>
      </div>
      <div class="flex flex-col gap-2">
        <Switch
          class="flex items-center justify-between"
          checked={appState.options.automaticCacheDeletion}
          onChange={(isChecked) =>
            setAppOptions(
              "automaticCacheDeletion",
              isChecked,
            )
          }
        >
          <SwitchLabel>
            {t(
              "setting.sender.automatic_cache_deletion.title",
            )}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t(
            "setting.sender.automatic_cache_deletion.description",
          )}
        </p>
      </div>
      <label class="flex flex-col gap-2">
        <Slider
          minValue={0}
          maxValue={9}
          step={1}
          defaultValue={[appState.options.compressionLevel]}
          getValueLabel={({ values }) =>
            values[0] === 0
              ? t(
                  "setting.sender.compression_level.no_compression",
                )
              : `${values[0]}`
          }
          class="gap-2"
          onChange={(value) => {
            setAppOptions(
              "compressionLevel",
              value[0] as CompressionLevel,
            );
          }}
        >
          <div class="flex w-full items-center justify-between gap-3">
            <SliderLabel>
              {t("setting.sender.compression_level.title")}
            </SliderLabel>
            <SliderValueLabel />
          </div>
          <SliderTrack>
            <SliderFill />
            <SliderThumb />
          </SliderTrack>
        </Slider>
        <p class="muted">
          {t(
            "setting.sender.compression_level.description",
          )}
        </p>
      </label>

      <h3 id="receiver" class="h3">
        {t("setting.receiver.title")}
      </h3>
      <div class="flex flex-col gap-2">
        <Switch
          class="flex items-center justify-between"
          checked={appState.options.automaticDownload}
          onChange={(isChecked) =>
            setAppOptions("automaticDownload", isChecked)
          }
        >
          <SwitchLabel>
            {t("setting.receiver.automatic_download.title")}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t(
            "setting.receiver.automatic_download.description",
          )}
        </p>
      </div>
    </section>
  );
}
