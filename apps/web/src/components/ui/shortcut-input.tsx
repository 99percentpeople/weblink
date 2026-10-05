import { RotateCcw } from "lucide-solid";
import { cn } from "@/libs/cn";
import {
  createEffect,
  createSignal,
  createUniqueId,
  onCleanup,
  Show,
} from "solid-js";
import { t } from "@/i18n";
import {
  recordShortcut,
  shortcutKeys,
  shortcutLabel,
} from "@/libs/domain/keyboard-shortcut";
import { Button } from "./button";
import { Label } from "./label";

/** Focus-scoped recorder. Save only complete chords; asynchronous rejection keeps the old value. */
export function ShortcutInput(props: {
  label: string;
  value: string;
  defaultValue: string;
  onChange(value: string): void | Promise<void>;
}) {
  const id = createUniqueId();
  const [recording, setRecording] = createSignal(false);
  const [pressed, setPressed] = createSignal<string[]>([]);
  const [candidate, setCandidate] = createSignal<{
    code: string;
    value: string;
  }>();
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal("");
  const cancel = () => {
    setRecording(false);
    setCandidate(undefined);
    setPressed([]);
  };
  const save = async (value: string) => {
    cancel();
    setError("");
    setSaving(true);
    try {
      await props.onChange(value);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : String(error),
      );
    } finally {
      setSaving(false);
    }
  };
  createEffect(() => {
    if (!recording()) return;
    let mainKey:
      | Pick<KeyboardEvent, "code" | "key">
      | undefined;
    const chord = (event: KeyboardEvent) => ({
      code: mainKey?.code ?? "",
      key: mainKey?.key,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
    });
    const controller = new AbortController();
    const options = {
      capture: true,
      signal: controller.signal,
    };
    document.addEventListener(
      "keydown",
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.repeat || event.isComposing) return;
        if (
          event.code === "Escape" &&
          !event.ctrlKey &&
          !event.altKey &&
          !event.shiftKey &&
          !event.metaKey
        ) {
          cancel();
          return;
        }
        if (
          !/^(Control|Alt|Shift|Meta)(Left|Right)$/.test(
            event.code,
          )
        )
          mainKey = { code: event.code, key: event.key };
        const next = chord(event);
        setPressed(shortcutKeys(next));
        const value = recordShortcut(next);
        setCandidate(
          value ? { code: next.code, value } : undefined,
        );
        setError(
          !mainKey || value
            ? ""
            : t("setting.shortcut_input.invalid"),
        );
      },
      options,
    );
    document.addEventListener(
      "keyup",
      (event) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        const next = candidate();
        if (next?.code === event.code) {
          void save(next.value);
          return;
        }
        if (mainKey?.code === event.code)
          mainKey = undefined;
        setPressed(shortcutKeys(chord(event)));
      },
      options,
    );
    window.addEventListener("blur", cancel, {
      signal: controller.signal,
    });
    onCleanup(() => controller.abort());
  });
  const display = () =>
    recording()
      ? pressed()
      : shortcutLabel(props.value)
          .split("+")
          .map((key) => key.trim());
  return (
    <div class="flex min-w-0 flex-col gap-1.5">
      <div class="flex min-w-0 items-center justify-between gap-3">
        <Label for={id} class="min-w-0">
          {props.label}
        </Label>
        <div class="flex min-w-0 items-center gap-1">
          <Button
            id={id}
            type="button"
            variant="outline"
            size="sm"
            class={cn(
              "h-7 min-w-0 shrink px-2 shadow-none",
              recording() &&
                "border-primary/60 bg-primary/5 text-primary",
            )}
            disabled={saving()}
            title={t("setting.shortcut_input.hint")}
            aria-describedby={`${id}-hint${error() ? ` ${id}-error` : ""}`}
            aria-invalid={!!error()}
            aria-pressed={recording()}
            aria-busy={saving()}
            onBlur={cancel}
            onClick={() => {
              if (recording()) {
                cancel();
                return;
              }
              setError("");
              setCandidate(undefined);
              setPressed([]);
              setRecording(true);
            }}
          >
            <span
              class="min-w-0 truncate text-xs font-normal"
              aria-live="polite"
            >
              <Show
                when={!saving()}
                fallback={t(
                  "setting.shortcut_input.saving",
                )}
              >
                <Show
                  when={
                    !recording() || pressed().length > 0
                  }
                  fallback={t(
                    "setting.shortcut_input.recording",
                  )}
                >
                  <kbd class="font-mono">
                    {display().join(" + ")}
                  </kbd>
                </Show>
              </Show>
            </span>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            class="text-muted-foreground size-7"
            title={t("setting.shortcut_input.reset")}
            aria-label={t("setting.shortcut_input.reset")}
            disabled={
              saving() || props.value === props.defaultValue
            }
            onClick={() => void save(props.defaultValue)}
          >
            <RotateCcw
              class="size-3.5"
              aria-hidden="true"
            />
          </Button>
        </div>
      </div>
      <span id={`${id}-hint`} class="sr-only">
        {t("setting.shortcut_input.hint")}
      </span>
      <Show when={error()}>
        <p
          id={`${id}-error`}
          role="alert"
          class="text-destructive text-xs"
        >
          {error()}
        </p>
      </Show>
    </div>
  );
}
