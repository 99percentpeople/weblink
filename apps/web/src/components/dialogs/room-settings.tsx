import {
  Switch,
  SwitchControl,
  SwitchDescription,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
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
    <div class="space-y-5">
      <RoomPermissions
        conversationId={props.conversationId}
      />
      <section class="space-y-3 border-t pt-5">
        <h3 class="text-sm font-medium">
          {t("room_dialog.actions")}
        </h3>
        <ConversationActions
          conversationId={props.conversationId}
          online={props.online}
          onDeleted={props.onDeleted}
        />
      </section>
    </div>
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
    <div class="space-y-5">
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
        <Switch
          class="flex flex-col gap-2"
          checked={config().autoDownloadFiles}
          onChange={(enabled) =>
            setRoomConfig(props.conversationId, {
              autoDownloadFiles: enabled,
            })
          }
        >
          <div class="flex items-center justify-between gap-4">
            <SwitchLabel>
              {t("room_dialog.auto_download.title")}
            </SwitchLabel>
            <SwitchControl>
              <SwitchThumb />
            </SwitchControl>
          </div>
          <SwitchDescription class="muted">
            {t("room_dialog.auto_download.description")}
          </SwitchDescription>
        </Switch>
      </Show>
    </div>
  );
}
