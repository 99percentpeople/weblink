import { Show } from "solid-js";
import { Download, RefreshCw } from "lucide-solid";
import type { AppUpdates } from "@/libs/state/create-app-updates";
import { useAppState } from "@/libs/state/app-state-context";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { SettingSwitch } from "./setting-controls";
import { Button } from "@/components/ui/button";
import { ProgressCircle } from "@/components/ui/progress-circle";
import { t } from "@/i18n";
import { SettingHeading } from "./setting-layout";

export function DesktopUpdateSettings() {
  const updates = useAppState().updates;
  return (
    <Show when={updates}>
      {(controller) => (
        <DesktopUpdates
          updates={controller()}
          automatic={appState.options.autoCheckUpdates}
          onAutomaticChange={(enabled) =>
            setAppOptions("autoCheckUpdates", enabled)
          }
        />
      )}
    </Show>
  );
}

export function DesktopUpdates(props: {
  updates: AppUpdates;
  automatic: boolean;
  onAutomaticChange(enabled: boolean): void;
}) {
  const {
    result,
    pending,
    error,
    progress,
    update,
    unavailableReason,
    percent,
    check,
    install,
  } = props.updates;
  const installStatus = () =>
    progress()?.phase === "installing"
      ? t("setting.updates.installing")
      : t("setting.updates.downloading");

  return (
    <div class="space-y-3">
      <SettingHeading>
        {t("setting.updates.title")}
      </SettingHeading>
      <p class="text-muted-foreground text-sm">
        {t("setting.updates.description")}
      </p>
      <SettingSwitch
        checked={props.automatic}
        onChange={props.onAutomaticChange}
        label={t("setting.updates.automatic")}
        description={t(
          "setting.updates.automatic_description",
        )}
      />
      <div class="flex flex-wrap gap-2">
        <Button
          variant="outline"
          disabled={pending() !== null}
          onClick={() => void check()}
        >
          <Show
            when={pending() === "check"}
            fallback={<RefreshCw class="size-4" />}
          >
            <ProgressCircle
              class="size-4"
              indeterminate
              aria-hidden="true"
            />
          </Show>
          {t("setting.updates.check")}
        </Button>
        <Button
          as="a"
          variant="ghost"
          href="https://github.com/99percentpeople/weblink/releases/latest"
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("setting.updates.releases")}
        </Button>
      </div>
      <div
        role="status"
        aria-live="polite"
        class="space-y-2 text-sm"
      >
        <Show when={pending() === "check"}>
          {t("setting.updates.checking")}
        </Show>
        <Show when={result()?.status === "current"}>
          {t("setting.updates.current")}
        </Show>
        <Show when={unavailableReason()}>
          {unavailableReason() === "development"
            ? t("setting.updates.development")
            : t("setting.updates.unsupported")}
        </Show>
        <Show when={update()}>
          {(available) => (
            <p>
              {t("setting.updates.available", {
                version: available().version,
              })}
            </p>
          )}
        </Show>
        <Show when={pending() === "install"}>
          <div class="flex items-center gap-3">
            <ProgressCircle
              value={percent()}
              indeterminate={percent() === undefined}
              aria-label={installStatus()}
            />
            <p>
              {installStatus()}
              <Show when={percent() !== undefined}>
                {" "}
                <span class="tabular-nums">
                  {percent()}%
                </span>
              </Show>
            </p>
          </div>
        </Show>
      </div>
      <Show when={error()}>
        <p role="alert" class="text-destructive text-sm">
          {error() === "check"
            ? t("setting.updates.check_failed")
            : t("setting.updates.install_failed")}
        </p>
      </Show>
      <Show when={update()}>
        {(available) => (
          <div class="space-y-3">
            <Show when={available().notes}>
              <details class="text-sm">
                <summary class="cursor-pointer">
                  {t("setting.updates.notes")}
                </summary>
                <p
                  class="text-muted-foreground mt-2 max-h-48 overflow-auto
                    whitespace-pre-wrap break-words"
                >
                  {available().notes}
                </p>
              </details>
            </Show>
            <p class="text-muted-foreground text-sm">
              {available().canInstall
                ? t("setting.updates.install_hint")
                : available().downloadKind === "portable"
                  ? t("setting.updates.portable_hint")
                  : t("setting.updates.manual_hint")}
            </p>
            <Show
              when={available().canInstall}
              fallback={
                <Button
                  as="a"
                  href={available().downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Download class="size-4" />
                  {available().downloadKind === "portable"
                    ? t("setting.updates.download_portable")
                    : t(
                        "setting.updates.download_installer",
                      )}
                </Button>
              }
            >
              <Button
                disabled={pending() !== null}
                onClick={() => void install()}
              >
                <Download class="size-4" />
                {t("setting.updates.install")}
              </Button>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
