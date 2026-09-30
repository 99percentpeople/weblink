import { serverTurnCredentialsUrl } from "@/libs/application/ice-server-service";
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
import { formatBtyeSize } from "@/libs/utils/format-filesize";
import { t } from "@/i18n";
import { setAppOptions } from "@/options";

import { appState } from "@/libs/state/app-state";
import NativeCaptureSettings from "./native-capture-settings";

export default function AdvancedSettings() {
  return (
    <section class="settings-section">
      <h4 id="advanced-connection" class="h4">
        {t(
          "setting.advanced_settings.advanced_connection.title",
        )}
      </h4>
      <div class="flex flex-col gap-2">
        <Switch
          class="flex items-center justify-between"
          checked={appState.options.relayOnly}
          disabled={
            !serverTurnCredentialsUrl &&
            appState.options.servers.turns.length === 0
          }
          onChange={(isChecked) =>
            setAppOptions("relayOnly", isChecked)
          }
        >
          <SwitchLabel>
            {t(
              "setting.advanced_settings.advanced_connection.relay_only.title",
            )}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t(
            "setting.advanced_settings.advanced_connection.relay_only.description",
          )}
        </p>
      </div>
      <h4 id="advanced-sender" class="h4">
        {t(
          "setting.advanced_settings.advanced_sender.title",
        )}
      </h4>
      <Slider
        minValue={Math.max(
          appState.options.blockSize,
          128 * 1024,
        )}
        maxValue={10 * 1024 * 1024}
        step={128 * 1024}
        defaultValue={[appState.options.chunkSize]}
        class="gap-2"
        getValueLabel={({ values }) =>
          formatBtyeSize(values[0], 2)
        }
        onChange={(value) => {
          setAppOptions("chunkSize", value[0]);
        }}
      >
        <div class="flex w-full items-center justify-between gap-3">
          <SliderLabel>
            {t("setting.sender.chunk_size.title")}
          </SliderLabel>
          <SliderValueLabel />
        </div>
        <SliderTrack>
          <SliderFill />
          <SliderThumb />
        </SliderTrack>
      </Slider>
      <Slider
        minValue={16 * 1024}
        maxValue={192 * 1024}
        step={16 * 1024}
        defaultValue={[appState.options.blockSize]}
        class="gap-2"
        getValueLabel={({ values }) =>
          formatBtyeSize(values[0], 0)
        }
        onChange={(value) => {
          setAppOptions("blockSize", value[0]);
        }}
      >
        <div class="flex w-full items-center justify-between gap-3">
          <SliderLabel>
            {t("setting.sender.block_size.title")}
          </SliderLabel>
          <SliderValueLabel />
        </div>
        <SliderTrack>
          <SliderFill />
          <SliderThumb />
        </SliderTrack>
      </Slider>
      <Slider
        minValue={256 * 1024}
        maxValue={16 * 1024 * 1024}
        step={256 * 1024}
        defaultValue={[
          appState.options.bufferedAmountHighWaterMark,
        ]}
        getValueLabel={({ values }) =>
          formatBtyeSize(values[0], 2)
        }
        class="gap-2"
        onChange={(value) => {
          setAppOptions(
            "bufferedAmountHighWaterMark",
            value[0],
          );
        }}
      >
        <div class="flex w-full items-center justify-between gap-3">
          <SliderLabel>
            {t("setting.sender.max_buffer_amount.title")}
          </SliderLabel>
          <SliderValueLabel />
        </div>
        <SliderTrack>
          <SliderFill />
          <SliderThumb />
        </SliderTrack>
      </Slider>

      <div class="flex flex-col gap-2">
        <Switch
          class="flex items-center justify-between"
          checked={appState.options.ordered}
          onChange={(isChecked) =>
            setAppOptions("ordered", isChecked)
          }
        >
          <SwitchLabel>
            {t("setting.sender.ordered.title")}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t("setting.sender.ordered.description")}
        </p>
      </div>
      <h4 id="advanced-receiver" class="h4">
        {t(
          "setting.advanced_settings.advanced_receiver.title",
        )}
      </h4>
      <label class="flex flex-col gap-2">
        <Slider
          minValue={1}
          maxValue={128}
          step={1}
          defaultValue={[
            appState.options.maxMomeryCacheSlices,
          ]}
          getValueLabel={({ values }) =>
            `${values[0]} (${formatBtyeSize(values[0] * appState.options.chunkSize, 0)})`
          }
          class="gap-2"
          onChange={(value) => {
            setAppOptions("maxMomeryCacheSlices", value[0]);
          }}
        >
          <div class="flex w-full items-center justify-between gap-3">
            <SliderLabel>
              {t(
                "setting.receiver.max_cached_chunks.title",
              )}
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
            "setting.receiver.max_cached_chunks.description",
          )}
        </p>
      </label>
      <NativeCaptureSettings />
    </section>
  );
}
