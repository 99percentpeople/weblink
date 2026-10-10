import { For, Show } from "solid-js";
import { RefreshCw } from "lucide-solid";
import { t } from "@/i18n";
import { useAppState } from "@/libs/state/app-state-context";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SettingRow } from "./setting-layout";

export default function InputDeviceSettings() {
  const { inputDevices, runtimeCapabilities } =
    useAppState();
  const state = inputDevices.state;
  const prefix = "setting.remote_control.devices.";
  return (
    <Show when={state.supported}>
      <div class="setting-group">
        <SettingRow
          layout="compact"
          label={t(`${prefix}title`)}
          description={t(`${prefix}description`)}
          hint={
            <div
              class="space-y-3"
              aria-live="polite"
              aria-busy={state.refreshing}
            >
              <Show when={!state.ready}>
                <p>{t(`${prefix}checking`)}</p>
              </Show>
              <Show when={state.snapshot}>
                {(snapshot) => (
                  <dl class="@sm/settings:grid-cols-2 grid gap-x-6 gap-y-2">
                    <For each={snapshot().capabilities}>
                      {(device) => (
                        <div class="flex min-w-0 items-center justify-between gap-3">
                          <dt>
                            {t(`${prefix}${device.kind}`)}
                          </dt>
                          <dd>
                            <Badge
                              variant={
                                device.availability ===
                                "available"
                                  ? "secondary"
                                  : "outline"
                              }
                            >
                              {t(
                                `${prefix}${device.availability}`,
                              )}
                            </Badge>
                          </dd>
                        </div>
                      )}
                    </For>
                  </dl>
                )}
              </Show>
              <Show when={state.failed}>
                <p role="alert" class="text-destructive">
                  {t(`${prefix}error`)}
                </p>
              </Show>
            </div>
          }
        >
          <Button
            type="button"
            variant="outline"
            size="sm"
            wrap
            disabled={state.refreshing}
            aria-busy={state.refreshing}
            onClick={() => void inputDevices.refresh()}
          >
            <RefreshCw
              classList={{
                "animate-spin": state.refreshing,
              }}
              aria-hidden="true"
            />
            {t(`${prefix}refresh`)}
          </Button>
        </SettingRow>
        <Show
          when={runtimeCapabilities()?.os === "windows"}
        >
          <For
            each={state.snapshot?.capabilities.filter(
              (device) =>
                device.driver &&
                device.availability !== "available",
            )}
          >
            {(device) => (
              <SettingRow
                layout="compact"
                label={device.driver!.name}
                description={t(
                  `${prefix}driver_description`,
                )}
                hint={
                  <Show
                    when={
                      device.driver?.maintenance ===
                      "retired"
                    }
                  >
                    {t(`${prefix}driver_retired`)}
                  </Show>
                }
              >
                <Button
                  as="a"
                  role="link"
                  variant="outline"
                  size="sm"
                  wrap
                  href={device.driver!.installUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t(`${prefix}install_driver`)}
                </Button>
              </SettingRow>
            )}
          </For>
        </Show>
      </div>
    </Show>
  );
}
