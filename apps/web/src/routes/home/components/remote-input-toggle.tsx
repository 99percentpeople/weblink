import type { JSX } from "solid-js";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";

export function RemoteInputToggle(props: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  title: string;
  onChange(value: boolean): void;
  children: JSX.Element;
}) {
  return (
    <>
      <span
        class="bg-input h-[18px] w-px shrink-0"
        aria-hidden="true"
      />
      <Switch
        class="flex shrink-0 items-center gap-1.5"
        title={props.title}
        checked={props.checked}
        disabled={props.disabled}
        onChange={props.onChange}
      >
        <SwitchLabel
          class="flex min-w-0 cursor-pointer items-center gap-[7px]
            text-[12px] font-medium max-md:text-[11px] sm:text-[12px]"
        >
          {props.children}
          <span class="sr-only">{props.label}</span>
        </SwitchLabel>
        <SwitchControl class="h-5 w-9 bg-[#ffffff26] data-[checked]:bg-[#365889]">
          <SwitchThumb class="size-4 bg-[#d4e3ff] data-[checked]:translate-x-4" />
        </SwitchControl>
      </Switch>
    </>
  );
}
