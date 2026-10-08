import type { SwitchRootProps } from "@kobalte/core/switch";
import {
  Description as SliderDescription,
  type SliderRootProps,
} from "@kobalte/core/slider";
import {
  Show,
  splitProps,
  type ComponentProps,
  type JSX,
} from "solid-js";
import type {
  SelectRootProps,
  SelectSingleSelectionOptions,
  SelectValueOptions,
} from "@kobalte/core/select";
import {
  Select,
  SelectContent,
  SelectValue,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";

import {
  Switch,
  SwitchControl,
  SwitchDescription,
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
import { ShortcutInput } from "@/components/ui/shortcut-input";
import {
  SettingField,
  SettingRow,
  type SettingContent,
} from "./setting-layout";

export function SettingSwitch(
  props: SettingContent & Omit<SwitchRootProps, "children">,
) {
  const [local, control] = splitProps(props, [
    "label",
    "description",
    "hint",
  ]);
  return (
    <Switch {...control} class="setting-item">
      <SettingRow
        layout="compact"
        disabled={control.disabled}
        label={<SwitchLabel>{local.label}</SwitchLabel>}
        description={
          <Show when={local.description}>
            <SwitchDescription>
              {local.description}
            </SwitchDescription>
          </Show>
        }
        hint={local.hint}
      >
        <SwitchControl>
          <SwitchThumb />
        </SwitchControl>
      </SettingRow>
    </Switch>
  );
}

export type SettingSelectProps<
  T,
  G = never,
> = SettingContent &
  Omit<
    SelectRootProps<T, G>,
    | "children"
    | "value"
    | "defaultValue"
    | "onChange"
    | "multiple"
    | "itemComponent"
  > &
  SelectSingleSelectionOptions<T> & {
    renderValue?: SelectValueOptions<T>["children"];
    optionLabel?: (option: T) => JSX.Element;
    itemComponent?: SelectRootProps<T, G>["itemComponent"];
  };
export function SettingSelect<T, G = never>(
  props: SettingSelectProps<T, G>,
) {
  const [local, control] = splitProps(props, [
    "label",
    "description",
    "hint",
    "renderValue",
    "optionLabel",
    "itemComponent",
  ]);
  return (
    <Select<T, G>
      {...control}
      class="setting-item"
      itemComponent={
        local.itemComponent ??
        ((item) => (
          <SelectItem item={item.item}>
            {local.optionLabel?.(item.item.rawValue) ??
              String(item.item.rawValue)}
          </SelectItem>
        ))
      }
    >
      <SettingField
        label={local.label}
        description={local.description}
        hint={local.hint}
        disabled={control.disabled}
      >
        {(ids) => (
          <>
            <SelectTrigger
              wrap
              id={ids.id}
              aria-labelledby={ids.labelId}
              aria-describedby={ids.descriptionId}
            >
              <SelectValue<T>>
                {local.renderValue ??
                  ((state) =>
                    state.selectedOption() == null
                      ? ""
                      : (local.optionLabel?.(
                          state.selectedOption(),
                        ) ??
                        String(state.selectedOption())))}
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </>
        )}
      </SettingField>
    </Select>
  );
}

export function SettingSlider(
  props: SettingContent & Omit<SliderRootProps, "children">,
) {
  const [local, control] = splitProps(props, [
    "label",
    "description",
    "hint",
  ]);
  return (
    <Slider
      {...control}
      class="setting-item setting-slider"
    >
      <SettingRow
        disabled={control.disabled}
        label={<SliderLabel>{local.label}</SliderLabel>}
        description={
          <Show when={local.description}>
            <SliderDescription>
              {local.description}
            </SliderDescription>
          </Show>
        }
        hint={local.hint}
      >
        <div class="setting-slider-control">
          <SliderValueLabel />
          <SliderTrack>
            <SliderFill />
            <SliderThumb />
          </SliderTrack>
        </div>
      </SettingRow>
    </Slider>
  );
}

export function SettingShortcut(
  props: ComponentProps<typeof ShortcutInput> &
    Pick<SettingContent, "description" | "hint">,
) {
  const [local, control] = splitProps(props, [
    "description",
    "hint",
  ]);
  return (
    <div class="setting-item setting-shortcut">
      <ShortcutInput {...control} />
      <Show when={local.description}>
        <div class="setting-description">
          {local.description}
        </div>
      </Show>
      <Show when={local.hint}>
        <div class="setting-hint">{local.hint}</div>
      </Show>
    </div>
  );
}
