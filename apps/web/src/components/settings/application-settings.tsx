import { SettingSection } from "./setting-layout";
import {
  SettingSwitch,
  SettingSelect,
} from "./setting-controls";
import { t } from "@/i18n";
import { setClientProfile } from "@/libs/state/profile-store";
import { Show } from "solid-js";
import type { ApplicationCloseBehavior } from "@/libs/domain/application-options";
import { platform } from "@/libs/platform/runtime";
import type { DocumentPictureInPictureAPI } from "@/libs/hooks/document-picture-in-picture";
import { appState } from "@/libs/state/app-state";
import { useAppState } from "@/libs/state/app-state-context";
import { setAppOptions } from "@/options";

import { Button } from "@/components/ui/button";

export default function ApplicationSettings() {
  const { runtimeCapabilities: capabilities, startup } =
    useAppState();
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
    <SettingSection
      id="application-settings"
      title={t("app_menu.settings_application")}
    >
      <SettingSwitch
        disabled={appState.profile.initalJoin}
        checked={appState.profile.autoJoin}
        onChange={(isChecked) =>
          setClientProfile("autoJoin", isChecked)
        }
        label={t("setting.connection.auto_join.title")}
        description={t(
          "setting.connection.auto_join.description",
        )}
      />
      <SettingSwitch
        disabled={!pipSupported}
        checked={application().automaticPictureInPicture}
        onChange={(value) =>
          setAppOptions(
            "application",
            "automaticPictureInPicture",
            value,
          )
        }
        label={t("meeting.pip_automatic")}
        description={t(
          platform.pictureInPicture
            ? "setting.application.automatic_pip_desktop_description"
            : pipSupported
              ? "setting.application.automatic_pip_description"
              : "setting.application.automatic_pip_unavailable",
        )}
      />
      <Show when={startup.supported}>
        <SettingSwitch
          checked={startup.enabled() === true}
          disabled={
            startup.busy() ||
            startup.pathMismatch() ||
            startup.enabled() === undefined
          }
          onChange={(enabled) =>
            void startup.setEnabled(enabled)
          }
          label={t("setting.application.autostart")}
          description={t(
            "setting.application.autostart_description",
          )}
          hint={
            <>
              <Show when={startup.pathMismatch()}>
                <div class="flex items-center justify-between gap-2">
                  <p class="muted" role="status">
                    {t(
                      "setting.application.autostart_path_mismatch",
                    )}
                  </p>
                  <Button
                    wrap
                    type="button"
                    variant="outline"
                    size="sm"
                    class="self-start"
                    disabled={startup.busy()}
                    onClick={() => void startup.repair()}
                  >
                    {t(
                      "setting.application.autostart_repair",
                    )}
                  </Button>
                </div>
              </Show>
            </>
          }
        />
        <SettingSelect<"tray" | "window">
          modal
          disallowEmptySelection
          options={["tray", "window"]}
          disabled={
            startup.busy() ||
            startup.enabled() === undefined
          }
          optionDisabled={(value) =>
            value === "tray" && !capabilities()?.systemTray
          }
          value={startup.behavior()}
          onChange={(value) => {
            if (value) void startup.setBehavior(value);
          }}
          label={t(
            "setting.application.startup_behavior.title",
          )}
          description={t(
            "setting.application.startup_behavior.description",
          )}
          optionLabel={(option) =>
            t(
              `setting.application.startup_behavior.${option}`,
            )
          }
        />
      </Show>
      <Show when={startup.failed()}>
        <p class="text-destructive text-sm" role="alert">
          {t("setting.application.autostart_failed")}
        </p>
      </Show>
      <Show when={platform.application}>
        <SettingSelect<ApplicationCloseBehavior>
          modal
          disallowEmptySelection
          options={["ask", "exit", "tray"]}
          optionDisabled={(value) =>
            value === "tray" && !capabilities()?.systemTray
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
          label={t(
            "setting.application.close_behavior.title",
          )}
          description={t(
            "setting.application.close_behavior.description",
          )}
          optionLabel={(option) =>
            t(
              `setting.application.close_behavior.${option}`,
            )
          }
        />
        <Show when={capabilities()?.remoteInput}>
          <SettingSwitch
            disabled={!capabilities()?.systemTray}
            checked={application().hideOnRemoteControl}
            onChange={(value) =>
              setAppOptions(
                "application",
                "hideOnRemoteControl",
                value,
              )
            }
            label={t("setting.application.auto_hide.title")}
            description={t(
              "setting.application.auto_hide.description",
            )}
          />
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
    </SettingSection>
  );
}
