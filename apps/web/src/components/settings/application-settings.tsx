import { t } from "@/i18n";
import { toast } from "solid-sonner";
import { setClientProfile } from "@/libs/state/profile-store";
import {
  createSignal,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { RuntimeCapabilities } from "@weblink/platform";
import type { ApplicationCloseBehavior } from "@/libs/domain/application-options";
import { platform } from "@/libs/platform/runtime";
import type { DocumentPictureInPictureAPI } from "@/libs/hooks/document-picture-in-picture";
import { appState } from "@/libs/state/app-state";
import { setAppOptions } from "@/options";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Switch,
  SwitchControl,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";

export default function ApplicationSettings() {
  // Capability discovery must not replace the settings shell with its Suspense fallback.
  const [capabilities, setCapabilities] =
    createSignal<RuntimeCapabilities>();
  let disposed = false;
  onCleanup(() => {
    disposed = true;
  });
  onMount(async () => {
    if (platform.kind !== "desktop") return;
    const detected = await platform
      .getCapabilities()
      .catch(() => undefined);
    if (!disposed) setCapabilities(detected);
  });
  const [autostart, setAutostart] = createSignal<boolean>();
  const [startupBehavior, setStartupBehavior] =
    createSignal<"tray" | "window">("tray");
  const [startupBusy, setStartupBusy] = createSignal(false);
  const startup = platform.application?.autostart;
  onMount(async () => {
    if (!startup) return;
    try {
      const [enabled, behavior] = await Promise.all([
        startup.enabled(),
        startup.behavior(),
      ]);
      if (!disposed) setStartupBehavior(behavior);
      if (!disposed) setAutostart(enabled);
    } catch (error) {
      console.warn(
        "Could not read autostart status",
        error,
      );
      if (!disposed)
        toast.error(
          t("setting.application.autostart_failed"),
        );
    }
  });
  const pipSupported =
    !!platform.pictureInPicture ||
    (platform.kind === "browser" &&
      typeof (
        window as Window & {
          documentPictureInPicture?: DocumentPictureInPictureAPI;
        }
      ).documentPictureInPicture?.requestWindow ===
        "function");
  const application = () => appState.options.application;
  return (
    <section
      class="settings-section"
      aria-labelledby="application-settings"
    >
      <h3 id="application-settings" class="h3">
        {t("app_menu.settings_application")}
      </h3>
      <div class="flex flex-col gap-2">
        <Switch
          disabled={appState.profile.initalJoin}
          class="flex items-center justify-between"
          checked={appState.profile.autoJoin}
          onChange={(isChecked) =>
            setClientProfile("autoJoin", isChecked)
          }
        >
          <SwitchLabel>
            {t("setting.connection.auto_join.title")}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t("setting.connection.auto_join.description")}
        </p>
      </div>
      <div class="flex flex-col gap-2">
        <Switch
          class="flex w-full items-center justify-between gap-3"
          disabled={!pipSupported}
          checked={application().automaticPictureInPicture}
          onChange={(value) =>
            setAppOptions(
              "application",
              "automaticPictureInPicture",
              value,
            )
          }
        >
          <SwitchLabel>
            {t("meeting.pip_automatic")}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </Switch>
        <p class="muted">
          {t(
            platform.pictureInPicture
              ? "setting.application.automatic_pip_desktop_description"
              : pipSupported
                ? "setting.application.automatic_pip_description"
                : "setting.application.automatic_pip_unavailable",
          )}
        </p>
      </div>
      <Show when={startup}>
        <div class="flex flex-col gap-2">
          <Switch
            class="flex w-full items-center justify-between gap-3"
            checked={autostart() === true}
            disabled={
              startupBusy() || autostart() === undefined
            }
            onChange={async (enabled) => {
              if (!startup || startupBusy()) return;
              setStartupBusy(true);
              try {
                const actual =
                  await startup.setEnabled(enabled);
                if (!disposed) setAutostart(actual);
              } catch (error) {
                console.warn(
                  "Could not update autostart",
                  error,
                );
                if (!disposed)
                  toast.error(
                    t(
                      "setting.application.autostart_failed",
                    ),
                  );
              } finally {
                if (!disposed) setStartupBusy(false);
              }
            }}
          >
            <SwitchLabel>
              {t("setting.application.autostart")}
            </SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </Switch>
          <p class="muted">
            {t("setting.application.autostart_description")}
          </p>
        </div>
        <div class="flex flex-col gap-2">
          <Label id="startup-behavior">
            {t(
              "setting.application.startup_behavior.title",
            )}
          </Label>
          <Select<"tray" | "window">
            modal
            disallowEmptySelection
            options={["tray", "window"]}
            disabled={
              startupBusy() || autostart() === undefined
            }
            optionDisabled={(value) =>
              value === "tray" &&
              !capabilities()?.systemTray
            }
            value={startupBehavior()}
            onChange={async (value) => {
              if (!startup || !value || startupBusy())
                return;
              setStartupBusy(true);
              try {
                await startup.setBehavior(value);
                if (!disposed) setStartupBehavior(value);
              } catch {
                if (!disposed)
                  toast.error(
                    t(
                      "setting.application.autostart_failed",
                    ),
                  );
              } finally {
                if (!disposed) setStartupBusy(false);
              }
            }}
            itemComponent={(props) => (
              <SelectItem item={props.item}>
                {t(
                  `setting.application.startup_behavior.${props.item.rawValue}`,
                )}
              </SelectItem>
            )}
          >
            <SelectTrigger aria-labelledby="startup-behavior">
              <SelectValue<"tray" | "window">>
                {(state) =>
                  t(
                    `setting.application.startup_behavior.${state.selectedOption()}`,
                  )
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
          <p class="muted">
            {t(
              "setting.application.startup_behavior.description",
            )}
          </p>
        </div>
      </Show>
      <Show when={platform.application}>
        <div class="flex flex-col gap-2">
          <Label id="application-close-behavior">
            {t("setting.application.close_behavior.title")}
          </Label>
          <Select<ApplicationCloseBehavior>
            modal
            disallowEmptySelection
            options={["ask", "exit", "tray"]}
            optionDisabled={(value) =>
              value === "tray" &&
              !capabilities()?.systemTray
            }
            value={application().closeBehavior}
            onChange={(value) =>
              value &&
              setAppOptions(
                "application",
                "closeBehavior",
                value,
              )
            }
            itemComponent={(props) => (
              <SelectItem item={props.item}>
                {t(
                  `setting.application.close_behavior.${props.item.rawValue}`,
                )}
              </SelectItem>
            )}
          >
            <SelectTrigger aria-labelledby="application-close-behavior">
              <SelectValue<ApplicationCloseBehavior>>
                {(state) =>
                  t(
                    `setting.application.close_behavior.${state.selectedOption()}`,
                  )
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
          <p class="muted">
            {t(
              "setting.application.close_behavior.description",
            )}
          </p>
        </div>
        <Show when={capabilities()?.remoteInput}>
          <div class="flex flex-col gap-2">
            <Switch
              class="flex w-full items-center justify-between gap-3"
              disabled={!capabilities()?.systemTray}
              checked={application().hideOnRemoteControl}
              onChange={(value) =>
                setAppOptions(
                  "application",
                  "hideOnRemoteControl",
                  value,
                )
              }
            >
              <SwitchLabel>
                {t("setting.application.auto_hide.title")}
              </SwitchLabel>
              <SwitchControl>
                <SwitchThumb />
              </SwitchControl>
            </Switch>
            <p class="muted">
              {t(
                "setting.application.auto_hide.description",
              )}
            </p>
          </div>
        </Show>
        <Show
          when={
            capabilities() && !capabilities()?.systemTray
          }
        >
          <p class="muted">
            {t("setting.application.tray_unavailable")}
          </p>
        </Show>
      </Show>
    </section>
  );
}
