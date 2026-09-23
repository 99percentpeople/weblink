import {
  Switch,
  SwitchControl,
  SwitchDescription,
  SwitchLabel,
  SwitchThumb,
} from "@/components/ui/switch";
import { t } from "@/i18n";
import { useMeetingSession } from "@/routes/video/components/meeting-session-context";

export function MeetingSettings() {
  const meeting = useMeetingSession();

  return (
    <section
      class="flex flex-col gap-4"
      aria-labelledby="meeting-settings"
    >
      <h3 id="meeting-settings" class="h3">
        {t("setting.meeting.title")}
      </h3>
      <Switch
        class="flex flex-col gap-2"
        checked={meeting.toolbarFollowsRail()}
        onChange={meeting.setToolbarFollowsRail}
      >
        <div class="flex items-center justify-between gap-4">
          <SwitchLabel>
            {t(
              "setting.meeting.toolbar_follows_rail.title",
            )}
          </SwitchLabel>
          <SwitchControl>
            <SwitchThumb />
          </SwitchControl>
        </div>
        <SwitchDescription class="muted">
          {t(
            "setting.meeting.toolbar_follows_rail.description",
          )}
        </SwitchDescription>
      </Switch>
    </section>
  );
}
