import {
  SettingBlock,
  SettingHeading,
  SettingGroup,
  SettingSection,
} from "@/components/settings/setting-layout";
import { ConversationActions } from "@/components/conversations/conversation-actions";
import { appState } from "@/libs/state/app-state";
import { resolveRoomConfig } from "@/libs/state/app-options";
import { setRoomConfig } from "@/options";
import { t } from "@/i18n";
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
}) {
  const config = () =>
    resolveRoomConfig(
      appState.options,
      props.conversationId,
    );
  return (
    <SettingSection>
      <SettingGroup
        title={t("setting.permissions.groups.content")}
      >
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
      </SettingGroup>
    </SettingSection>
  );
}
