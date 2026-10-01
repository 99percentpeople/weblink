import { t } from "@/i18n";
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
  const pipSupported =
    platform.kind === "browser" &&
    typeof (
      window as Window & {
        documentPictureInPicture?: DocumentPictureInPictureAPI;
      }
    ).documentPictureInPicture?.requestWindow ===
      "function";
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
            pipSupported
              ? "setting.application.automatic_pip_description"
              : "setting.application.automatic_pip_unavailable",
          )}
        </p>
      </div>
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
