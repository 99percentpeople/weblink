import { createSignal, Show } from "solid-js";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { parseSignalingOverride } from "@/libs/domain/signaling-endpoint";
import { signalingWebSocketUrl } from "@/libs/state/app-options";
import {
  appState,
  getSignalingWebSocketUrl,
} from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { SettingField } from "./setting-layout";

export function SignalingServerSetting() {
  const defaultUrl = signalingWebSocketUrl;
  const normalizedDefault =
    parseSignalingOverride(defaultUrl);
  const [draft, setDraft] = createSignal<string>();
  const value = () => draft() ?? getSignalingWebSocketUrl();
  const invalid = () =>
    draft() !== undefined &&
    parseSignalingOverride(value()) === null;

  function save(url: string) {
    const override = url === normalizedDefault ? "" : url;
    setAppOptions("customSignalingUrl", override);
  }

  function reset() {
    save("");
    setDraft(undefined);
  }

  return (
    <SettingField
      layout="stacked"
      label={t("setting.connection.signaling.title")}
      description={t(
        "setting.connection.signaling.description",
      )}
    >
      {(ids) => (
        <div class="flex flex-col items-end gap-2">
          <Input
            id={ids.id}
            type="url"
            inputmode="url"
            autocomplete="off"
            spellcheck={false}
            aria-describedby={
              invalid()
                ? `${ids.descriptionId} ${ids.id}-error`
                : ids.descriptionId
            }
            aria-invalid={invalid()}
            value={value()}
            onInput={(event) => {
              const input = event.currentTarget.value;
              setDraft(input);
              const url = parseSignalingOverride(input);
              if (url) save(url);
            }}
            onBlur={() => {
              if (!value().trim()) reset();
              else if (!invalid()) setDraft(undefined);
            }}
          />
          <Show when={invalid()}>
            <p
              class="text-destructive text-sm"
              role="alert"
              id={`${ids.id}-error`}
            >
              {t("setting.connection.signaling.invalid")}
            </p>
          </Show>
          <Show
            when={
              appState.options.customSignalingUrl ||
              value() !== defaultUrl
            }
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={reset}
            >
              {t("common.action.reset")}
            </Button>
          </Show>
        </div>
      )}
    </SettingField>
  );
}
