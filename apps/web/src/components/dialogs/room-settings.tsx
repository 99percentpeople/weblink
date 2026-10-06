import { SettingSwitch } from "@/components/settings/setting-controls";
import {
  SettingBlock,
  SettingHeading,
  SettingSection,
} from "@/components/settings/setting-layout";
import { ConversationActions } from "@/components/conversations/conversation-actions";
import { appState } from "@/libs/state/app-state";
import { resolveRoomConfig } from "@/libs/state/app-options";
import { setRoomConfig } from "@/options";
import { t } from "@/i18n";
import { Show } from "solid-js";
import { PermissionSelect } from "@/components/settings/permission-select";

export function RoomSettings(props: {
  conversationId: string;
  online: boolean;
  onDeleted?(): void;
}) {
  return (
    <SettingSection>
      <RoomPermissions
        conversationId={props.conversationId}
      />
      <SettingBlock separated>
        <SettingHeading>
          {t("room_dialog.actions")}
        </SettingHeading>
        <ConversationActions
          conversationId={props.conversationId}
          online={props.online}
          onDeleted={props.onDeleted}
        />
      </SettingBlock>
    </SettingSection>
  );
}

export function RoomPermissions(props: {
  conversationId: string;
  control?: "switch" | "select";
}) {
  const config = () =>
    resolveRoomConfig(
      appState.options,
      props.conversationId,
    );
  return (
    <div class="setting-group">
      <Show
        when={props.control !== "select"}
        fallback={
          <PermissionSelect<"allowed" | "disallowed">
            label={t("room_dialog.auto_download.title")}
            description={t(
              "room_dialog.auto_download.description",
            )}
            options={["allowed", "disallowed"]}
            value={
              config().autoDownloadFiles
                ? "allowed"
                : "disallowed"
            }
            optionLabel={(decision) =>
              t(`setting.permissions.${decision}`)
            }
            onChange={(decision) =>
              setRoomConfig(props.conversationId, {
                autoDownloadFiles: decision === "allowed",
              })
            }
          />
        }
      >
        <SettingSwitch
          label={t("room_dialog.auto_download.title")}
          description={t(
            "room_dialog.auto_download.description",
          )}
          checked={config().autoDownloadFiles}
          onChange={(enabled) =>
            setRoomConfig(props.conversationId, {
              autoDownloadFiles: enabled,
            })
          }
        />
      </Show>
    </div>
  );
}
