import { SettingSelect } from "./setting-controls";

export function PermissionSelect<T extends string>(props: {
  label: string;
  description?: string;
  options: T[];
  value: T;
  optionLabel(value: T): string;
  onChange(value: T): void;
}) {
  return (
    <SettingSelect<T>
      modal
      disallowEmptySelection
      label={props.label}
      description={props.description}
      options={props.options}
      value={props.value}
      optionLabel={props.optionLabel}
      onChange={(value) => {
        if (value !== null) props.onChange(value);
      }}
    />
  );
}
