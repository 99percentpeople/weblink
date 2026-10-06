import { SettingSection } from "./setting-layout";
import { SettingSwitch } from "./setting-controls";
import { For, Show } from "solid-js";
import { BellRing, LoaderCircle } from "lucide-solid";
import { useAppState } from "@/libs/state/app-state-context";
import { platform } from "@/libs/platform/runtime";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";

import { toast } from "solid-sonner";

export default function NotificationSettings() {
  const {
    capabilities,
    status,
    failure,
    busy,
    requestPermission,
    requestUnresolved,
  } = useAppState().permissions.notifications;
  const keys = [
    "enabled",
    "backgroundOnly",
    "messages",
    "controlRequests",
    "speedTestRequests",
    "transfers",
    "preview",
    "sound",
  ] as const;
  return (
    <SettingSection
      id="notification-settings"
      title={t("app_menu.settings_notifications")}
    >
      <div class="flex flex-col gap-2">
        <p
          class="text-sm leading-relaxed"
          role="status"
          aria-live="polite"
        >
          {status() === "loading"
            ? t("setting.notifications.loading")
            : status() === "error"
              ? t("setting.notifications.load_failed")
              : platform.kind === "browser" &&
                  capabilities()?.permission === "denied"
                ? t("setting.notifications.browser_blocked")
                : t(
                    `setting.notifications.permission_${capabilities()!.permission}`,
                  )}
        </p>
        <Show when={status() === "error"}>
          <details class="muted">
            <summary>
              {t("setting.notifications.error_details")}
            </summary>
            <p class="break-words">{failure()}</p>
          </details>
        </Show>
        <Show
          when={
            status() === "ready" &&
            capabilities()?.permission === "default" &&
            !requestUnresolved()
          }
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            class="self-start"
            disabled={busy()}
            aria-busy={busy()}
            onClick={() => {
              void requestPermission().catch(() => {
                toast.error(
                  t(
                    "setting.notifications.permission_failed",
                  ),
                );
              });
            }}
          >
            <Show
              when={busy()}
              fallback={<BellRing aria-hidden="true" />}
            >
              <LoaderCircle
                class="animate-spin"
                aria-hidden="true"
              />
            </Show>
            {t(
              busy()
                ? "setting.notifications.requesting"
                : "setting.notifications.allow",
            )}
          </Button>
        </Show>
        <Show
          when={
            platform.kind === "browser" &&
            status() === "ready" &&
            requestUnresolved()
          }
        >
          <p role="status">
            {t("setting.notifications.request_unresolved")}
          </p>
        </Show>
      </div>
      <For each={keys}>
        {(key) => (
          <SettingSwitch
            checked={appState.options.notifications[key]}
            disabled={
              key !== "enabled" &&
              !appState.options.notifications.enabled
            }
            onChange={(value) =>
              setAppOptions("notifications", key, value)
            }
            label={t(`setting.notifications.${key}`)}
          />
        )}
      </For>
    </SettingSection>
  );
}
