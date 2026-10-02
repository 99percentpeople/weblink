import { For, Show } from "solid-js";
import {
  BellRing,
  LoaderCircle,
  RotateCw,
} from "lucide-solid";
import { createNotificationPermission } from "@/libs/hooks/notification-permission";
import { platform } from "@/libs/platform/runtime";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { t } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import { toast } from "solid-sonner";

export default function NotificationSettings() {
  const {
    capabilities,
    status,
    failure,
    busy,
    refresh,
    requestPermission,
  } = createNotificationPermission();
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
    <section
      class="settings-section"
      aria-labelledby="notification-settings"
    >
      <h3 id="notification-settings" class="h3">
        {t("app_menu.settings_notifications")}
      </h3>
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
          <Button
            variant="outline"
            size="sm"
            class="self-start"
            onClick={() => void refresh()}
          >
            <RotateCw aria-hidden="true" />
            {t("setting.notifications.retry")}
          </Button>
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
            capabilities()?.permission === "default"
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
        <Show when={status() === "ready"}>
          <p class="muted">
            {t(
              capabilities()?.reply
                ? "setting.notifications.native_description"
                : "setting.notifications.basic_description",
            )}
          </p>
        </Show>
      </div>
      <For each={keys}>
        {(key) => (
          <div class="flex flex-col gap-2">
            <Switch
              class="flex w-full items-center justify-between gap-3"
              checked={appState.options.notifications[key]}
              disabled={
                key !== "enabled" &&
                !appState.options.notifications.enabled
              }
              onChange={(value) =>
                setAppOptions("notifications", key, value)
              }
            >
              <SwitchLabel>
                {t(`setting.notifications.${key}`)}
              </SwitchLabel>
              <SwitchControl>
                <SwitchThumb />
              </SwitchControl>
            </Switch>
          </div>
        )}
      </For>
    </section>
  );
}
