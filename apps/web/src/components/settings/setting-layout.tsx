import {
  Show,
  createUniqueId,
  type JSX,
  type ParentProps,
} from "solid-js";
import { Label } from "@/components/ui/label";
import "./settings.css";

export interface SettingContent {
  label: JSX.Element;
  description?: JSX.Element;
  hint?: JSX.Element;
}

export function SettingSection(
  props: ParentProps<{
    title?: JSX.Element;
    description?: JSX.Element;
    class?: string;
    id?: string;
  }>,
) {
  const id = props.id ?? createUniqueId();
  return (
    <section
      class={`settings-section ${props.class ?? ""}`}
      aria-labelledby={props.title ? id : undefined}
    >
      <Show when={props.title}>
        <header class="setting-section-header">
          <h3 id={id}>{props.title}</h3>
          <Show when={props.description}>
            <p class="setting-description">
              {props.description}
            </p>
          </Show>
        </header>
      </Show>
      {props.children}
    </section>
  );
}

export function SettingHeading(
  props: ParentProps<{
    id?: string;
    description?: JSX.Element;
  }>,
) {
  return (
    <header class="setting-group-heading">
      <h4 id={props.id}>{props.children}</h4>
      <Show when={props.description}>
        <p class="setting-description">
          {props.description}
        </p>
      </Show>
    </header>
  );
}

/** Shared spacing for custom content such as previews, actions and maintenance groups. */
export function SettingBlock(
  props: ParentProps<{ separated?: boolean }>,
) {
  return (
    <div
      class="setting-block"
      data-separated={props.separated || undefined}
    >
      {props.children}
    </div>
  );
}

/** Layout only: controls retain their own state, validation and permission rules. */
export function SettingRow(
  props: ParentProps<
    SettingContent & {
      layout?: "row" | "compact" | "stacked";
      disabled?: boolean;
      groupLabelId?: string;
    }
  >,
) {
  return (
    <div
      class="setting-item setting-row"
      role={props.groupLabelId ? "group" : undefined}
      aria-labelledby={props.groupLabelId}
      data-layout={props.layout ?? "row"}
      data-disabled={props.disabled || undefined}
    >
      <div class="setting-label">{props.label}</div>
      <div class="setting-control">{props.children}</div>
      <Show when={props.description}>
        <div class="setting-description">
          {props.description}
        </div>
      </Show>
      <Show when={props.hint}>
        <div class="setting-hint">{props.hint}</div>
      </Show>
    </div>
  );
}

export interface SettingFieldIds {
  id: string;
  labelId: string;
  descriptionId: string | undefined;
}
export function SettingField(
  props: SettingContent & {
    id?: string;
    layout?: "row" | "compact" | "stacked";
    disabled?: boolean;
    children: (ids: SettingFieldIds) => JSX.Element;
  },
) {
  const id = props.id ?? createUniqueId();
  const ids = {
    id,
    labelId: `${id}-label`,
    get descriptionId() {
      return props.description
        ? `${id}-description`
        : undefined;
    },
  };
  return (
    <SettingRow
      groupLabelId={ids.labelId}
      layout={props.layout}
      disabled={props.disabled}
      label={
        <Label id={ids.labelId} for={id}>
          {props.label}
        </Label>
      }
      description={
        <Show when={props.description}>
          <span id={ids.descriptionId}>
            {props.description}
          </span>
        </Show>
      }
      hint={props.hint}
    >
      {props.children(ids)}
    </SettingRow>
  );
}
