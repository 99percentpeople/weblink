import { Show, createUniqueId } from "solid-js";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectDescription,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export function PermissionSelect<T extends string>(props: {
  label: string;
  description?: string;
  options: T[];
  value: T;
  optionLabel(value: T): string;
  onChange(value: T): void;
}) {
  const id = createUniqueId();
  const labelId = `${id}-label`;
  return (
    <div class="flex flex-col gap-2">
      <Label id={labelId} for={id}>
        {props.label}
      </Label>
      <Select<T>
        modal
        disallowEmptySelection
        class="flex flex-col gap-2"
        options={props.options}
        value={props.value}
        onChange={(value) => {
          if (value !== null) props.onChange(value);
        }}
        itemComponent={(item) => (
          <SelectItem item={item.item}>
            {props.optionLabel(item.item.rawValue)}
          </SelectItem>
        )}
      >
        <SelectTrigger id={id} aria-labelledby={labelId}>
          <SelectValue<T>>
            {(state) => {
              const value = state.selectedOption();
              return value == null
                ? ""
                : props.optionLabel(value);
            }}
          </SelectValue>
        </SelectTrigger>
        <SelectContent />
        <Show when={props.description}>
          <SelectDescription class="muted">
            {props.description}
          </SelectDescription>
        </Show>
      </Select>
    </div>
  );
}
