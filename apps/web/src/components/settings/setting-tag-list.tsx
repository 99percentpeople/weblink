import {
  For,
  Show,
  createEffect,
  createSignal,
  on,
  type JSX,
} from "solid-js";
import { Check, Plus, X } from "lucide-solid";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { textareaAutoResize } from "@/libs/hooks/input-resize";
import {
  SettingField,
  type SettingContent,
} from "./setting-layout";

export interface SettingTagListProps extends SettingContent {
  values: readonly string[];
  placeholder: string;
  itemLabel?: (value: string) => string;
  actions?: JSX.Element;
  onChange: (values: string[]) => void;
  errorMessage: (error: unknown) => string;
}

/** Inline changes save immediately; bulk edits are applied as one validated update. */
export function SettingTagList(props: SettingTagListProps) {
  const [draft, setDraft] = createSignal("");
  const [editing, setEditing] = createSignal<number>();
  const [bulk, setBulk] = createSignal(false);
  const [bulkDraft, setBulkDraft] = createSignal("");
  const [error, setError] = createSignal<string>();
  let input:
    | HTMLInputElement
    | HTMLTextAreaElement
    | undefined;
  const label = (value: string) =>
    props.itemLabel?.(value) ?? value;
  const clearDraft = () => {
    setDraft("");
    setEditing(undefined);
    setError(undefined);
  };
  // Deployment resets and other settings changes must also refresh an open editor.
  createEffect(
    on(
      () => props.values.join("\n"),
      (value) => {
        clearDraft();
        setBulkDraft(value);
      },
      { defer: true },
    ),
  );
  const save = (values: string[]): boolean => {
    try {
      props.onChange([
        ...new Set(
          values
            .map((value) => value.trim())
            .filter(Boolean),
        ),
      ]);
      setError(undefined);
      return true;
    } catch (cause) {
      setError(props.errorMessage(cause));
      return false;
    }
  };
  const withDraft = (): string[] => {
    const values = [...props.values];
    if (draft().trim()) {
      const index = editing();
      if (index === undefined) values.push(draft());
      else values[index] = draft();
    }
    return values;
  };
  const commit = (): boolean => {
    if (!draft().trim()) return true;
    if (!save(withDraft())) return false;
    clearDraft();
    input?.focus();
    return true;
  };
  const edit = (value: string) => {
    if (!commit()) return;
    const index = props.values.indexOf(value);
    if (index < 0) return;
    setEditing(index);
    setDraft(value);
    input?.focus();
    input?.select();
  };
  const remove = (index: number) => {
    const text = draft();
    const active = editing();
    if (!save(props.values.filter((_, i) => i !== index)))
      return;
    if (active === index) clearDraft();
    else {
      setDraft(text);
      setEditing(
        active !== undefined && active > index
          ? active - 1
          : active,
      );
    }
    input?.focus();
  };
  const startBulk = () => {
    setBulkDraft(withDraft().join("\n"));
    clearDraft();
    setBulk(true);
    input?.focus();
  };
  const closeBulk = () => {
    setError(undefined);
    setBulk(false);
    input?.focus();
  };

  return (
    <SettingField
      label={props.label}
      description={props.description}
      layout="stacked"
      hint={
        <>
          <div class="setting-tag-toolbar">
            <span>
              {t(
                bulk()
                  ? "setting.list.bulk_hint"
                  : "setting.list.inline_hint",
              )}
            </span>
            <div class="setting-tag-actions">
              <Show
                when={bulk()}
                fallback={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={startBulk}
                  >
                    {t("setting.list.bulk_edit")}
                  </Button>
                }
              >
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={closeBulk}
                >
                  {t("common.action.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    if (save(bulkDraft().split("\n")))
                      closeBulk();
                  }}
                >
                  {t("setting.list.save")}
                </Button>
              </Show>
              {props.actions}
            </div>
          </div>
          {props.hint}
        </>
      }
    >
      {(ids) => {
        const describedBy = () =>
          [
            ids.descriptionId,
            error() ? `${ids.id}-error` : undefined,
          ]
            .filter(Boolean)
            .join(" ") || undefined;
        return (
          <>
            <Show
              when={bulk()}
              fallback={
                <div
                  class="setting-tag-input"
                  data-invalid={!!error() || undefined}
                >
                  <For each={props.values}>
                    {(value, index) => (
                      <span
                        class="setting-tag"
                        data-editing={
                          editing() === index() || undefined
                        }
                      >
                        <button
                          type="button"
                          class="setting-tag-label"
                          title={label(value)}
                          aria-label={`${t("setting.list.edit")} ${label(value)}`}
                          onClick={() => edit(value)}
                        >
                          {label(value)}
                        </button>
                        <button
                          type="button"
                          class="setting-tag-remove"
                          aria-label={`${t("setting.list.remove")} ${label(value)}`}
                          onClick={() => remove(index())}
                        >
                          <X aria-hidden="true" />
                        </button>
                      </span>
                    )}
                  </For>
                  <input
                    ref={(element) => {
                      input = element;
                    }}
                    id={ids.id}
                    class="setting-tag-draft"
                    aria-labelledby={ids.labelId}
                    aria-describedby={describedBy()}
                    aria-invalid={!!error()}
                    placeholder={props.placeholder}
                    autocomplete="off"
                    autocapitalize="none"
                    spellcheck={false}
                    value={draft()}
                    onInput={(event) => {
                      setDraft(event.currentTarget.value);
                      setError(undefined);
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.isComposing ||
                        event.keyCode === 229
                      )
                        return;
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commit();
                      }
                      if (
                        event.key === "Escape" &&
                        (draft() || editing() !== undefined)
                      ) {
                        event.preventDefault();
                        event.stopPropagation();
                        clearDraft();
                      }
                    }}
                  />
                  <Show when={editing() !== undefined}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={t("common.action.cancel")}
                      onClick={() => {
                        clearDraft();
                        input?.focus();
                      }}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  </Show>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={!draft().trim()}
                    aria-label={t(
                      editing() === undefined
                        ? "setting.list.add"
                        : "setting.list.save",
                    )}
                    onClick={commit}
                  >
                    <Show
                      when={editing() !== undefined}
                      fallback={<Plus aria-hidden="true" />}
                    >
                      <Check aria-hidden="true" />
                    </Show>
                  </Button>
                </div>
              }
            >
              <Textarea
                ref={(element) => {
                  input = element;
                  textareaAutoResize(element, bulkDraft);
                }}
                id={ids.id}
                class="setting-tag-bulk scrollbar-thin"
                rows={3}
                aria-labelledby={ids.labelId}
                aria-describedby={describedBy()}
                aria-invalid={!!error()}
                placeholder={props.placeholder}
                autocomplete="off"
                autocapitalize="none"
                spellcheck={false}
                value={bulkDraft()}
                onInput={(event) => {
                  setBulkDraft(event.currentTarget.value);
                  setError(undefined);
                }}
              />
            </Show>
            <Show when={error()}>
              <p
                id={`${ids.id}-error`}
                class="setting-tag-error"
                role="alert"
              >
                {error()}
              </p>
            </Show>
          </>
        );
      }}
    </SettingField>
  );
}
