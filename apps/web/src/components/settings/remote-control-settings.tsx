import { For, Show } from "solid-js";
import { t } from "@/i18n";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Slider,
  SliderFill,
  SliderLabel,
  SliderThumb,
  SliderTrack,
  SliderValueLabel,
} from "@/components/ui/slider";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import {
  resolveRemoteTouchOptions,
  type LongPressAction,
  type ThreeFingerTapAction,
  type TouchMode,
} from "@/libs/domain/remote-control/touch-options";

import RemoteKeyboardSettings from "./remote-keyboard-settings";

export default function RemoteControlSettings() {
  const options = () =>
    resolveRemoteTouchOptions(appState.options.remoteTouch);
  const prefix = "setting.remote_control.";
  const toggle = (
    key:
      | "tapToClick"
      | "twoFingerRightClick"
      | "twoFingerScroll"
      | "naturalScroll",
  ) => (
    <Switch
      class="flex w-full items-center justify-between gap-3"
      checked={options()[key]}
      onChange={(value) =>
        setAppOptions("remoteTouch", key, value)
      }
      disabled={
        key === "naturalScroll" &&
        !options().twoFingerScroll
      }
    >
      <SwitchLabel>{t(`${prefix}${key}`)}</SwitchLabel>
      <SwitchControl>
        <SwitchThumb />
      </SwitchControl>
    </Switch>
  );
  return (
    <section
      class="settings-section"
      aria-labelledby="remote-control-settings"
    >
      <h3 id="remote-control-settings" class="h3">
        {t("app_menu.settings_remote_control")}
      </h3>
      <h4 class="h3">{t(`${prefix}keyboard_heading`)}</h4>
      <RemoteKeyboardSettings />
      <h4 class="h3">{t(`${prefix}touch_heading`)}</h4>
      <p class="muted">{t(`${prefix}description`)}</p>
      <div class="flex flex-col gap-2">
        <Label id="remote-touch-mode">
          {t(`${prefix}mode.title`)}
        </Label>
        <Select<TouchMode>
          modal
          disallowEmptySelection
          value={options().mode}
          onChange={(value) =>
            value &&
            setAppOptions("remoteTouch", "mode", value)
          }
          options={["trackpad", "direct"]}
          itemComponent={(props) => (
            <SelectItem item={props.item}>
              {t(`${prefix}mode.${props.item.rawValue}`)}
            </SelectItem>
          )}
        >
          <SelectTrigger aria-labelledby="remote-touch-mode">
            <SelectValue<TouchMode>>
              {(state) =>
                t(`${prefix}mode.${state.selectedOption()}`)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent />
        </Select>
        <p class="muted">
          {t(`${prefix}mode.${options().mode}_description`)}
        </p>
      </div>
      <Show when={options().mode === "trackpad"}>
        <Slider
          minValue={0.25}
          maxValue={3}
          step={0.05}
          value={[options().pointerSpeed]}
          onChange={(value) =>
            setAppOptions(
              "remoteTouch",
              "pointerSpeed",
              value[0],
            )
          }
          getValueLabel={({ values }) =>
            `${values[0].toFixed(2)}×`
          }
          class="gap-2"
        >
          <div class="flex w-full items-center justify-between gap-3">
            <SliderLabel>
              {t(`${prefix}pointer_speed`)}
            </SliderLabel>
            <SliderValueLabel />
          </div>
          <SliderTrack>
            <SliderFill />
            <SliderThumb />
          </SliderTrack>
        </Slider>
        {toggle("tapToClick")}
        <div class="flex flex-col gap-2">
          <Label id="remote-long-press">
            {t(`${prefix}long_press.title`)}
          </Label>
          <Select<LongPressAction>
            modal
            disallowEmptySelection
            value={options().longPress}
            onChange={(value) =>
              value &&
              setAppOptions(
                "remoteTouch",
                "longPress",
                value,
              )
            }
            options={["drag", "right-click", "none"]}
            itemComponent={(props) => (
              <SelectItem item={props.item}>
                {t(
                  `${prefix}long_press.${props.item.rawValue}`,
                )}
              </SelectItem>
            )}
          >
            <SelectTrigger aria-labelledby="remote-long-press">
              <SelectValue<LongPressAction>>
                {(state) =>
                  t(
                    `${prefix}long_press.${state.selectedOption()}`,
                  )
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </div>
        <For
          each={
            [
              "twoFingerRightClick",
              "twoFingerScroll",
              "naturalScroll",
            ] as const
          }
        >
          {toggle}
        </For>
        <Slider
          minValue={0.25}
          maxValue={3}
          step={0.05}
          value={[options().scrollSpeed]}
          disabled={!options().twoFingerScroll}
          onChange={(value) =>
            setAppOptions(
              "remoteTouch",
              "scrollSpeed",
              value[0],
            )
          }
          getValueLabel={({ values }) =>
            `${values[0].toFixed(2)}×`
          }
          class="gap-2"
        >
          <div class="flex w-full items-center justify-between gap-3">
            <SliderLabel>
              {t(`${prefix}scroll_speed`)}
            </SliderLabel>
            <SliderValueLabel />
          </div>
          <SliderTrack>
            <SliderFill />
            <SliderThumb />
          </SliderTrack>
        </Slider>
        <div class="flex flex-col gap-2">
          <Label id="remote-three-finger-tap">
            {t(`${prefix}three_finger_tap.title`)}
          </Label>
          <Select<ThreeFingerTapAction>
            modal
            disallowEmptySelection
            value={options().threeFingerTap}
            onChange={(value) =>
              value &&
              setAppOptions(
                "remoteTouch",
                "threeFingerTap",
                value,
              )
            }
            options={["keyboard", "none"]}
            itemComponent={(props) => (
              <SelectItem item={props.item}>
                {t(
                  `${prefix}three_finger_tap.${props.item.rawValue}`,
                )}
              </SelectItem>
            )}
          >
            <SelectTrigger aria-labelledby="remote-three-finger-tap">
              <SelectValue<ThreeFingerTapAction>>
                {(state) =>
                  t(
                    `${prefix}three_finger_tap.${state.selectedOption()}`,
                  )
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
          <p class="muted">
            {t(`${prefix}three_finger_tap.description`)}
          </p>
        </div>
      </Show>
      <p class="muted">{t(`${prefix}changes`)}</p>
    </section>
  );
}
