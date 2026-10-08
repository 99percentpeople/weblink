import NotificationSettings from "./notification-settings";
import { For, Match, Switch } from "solid-js";
import {
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { ResponsiveTabs } from "@/components/ui/responsive-tabs";
import { t } from "@/i18n";
import AppearanceSettings from "./appearance-settings";
import ApplicationSettings from "./application-settings";
import { ConnectionSettings } from "./connection-settings";
import TransferSettings from "./transfer-settings";
import MeetingSettings from "./meeting-settings";
import RemoteControlSettings from "./remote-control-settings";
import PermissionsSettings from "./permissions-settings";
import AdvancedSettings from "./advanced-settings";
import AboutSettings from "./about-settings";

export const settingsSections = [
  "appearance",
  "application",
  "notifications",
  "connection",
  "transfer",
  "meeting",
  "remote_control",
  "permissions",
  "advanced",
  "about",
] as const;
export type SettingsSection =
  (typeof settingsSections)[number];

export default function SettingsContent(props: {
  section: SettingsSection;
  onSectionChange(section: SettingsSection): void;
  onClose(): void;
}) {
  return (
    <ResponsiveTabs
      value={props.section}
      onChange={(value) =>
        props.onSectionChange(value as SettingsSection)
      }
    >
      <TabsList
        aria-label={t("app_menu.settings_categories")}
        onKeyDown={(event) => {
          // Kobalte's collection consumes Escape even though a tab cannot
          // clear its selection. Let the settings dialog close instead.
          if (
            event.key === "Escape" &&
            !event.defaultPrevented
          ) {
            event.preventDefault();
            props.onClose();
          }
        }}
      >
        <For each={settingsSections}>
          {(section) => (
            <TabsTrigger value={section}>
              {t(`app_menu.settings_${section}`)}
            </TabsTrigger>
          )}
        </For>
        <TabsIndicator />
      </TabsList>
      <For each={settingsSections}>
        {(section) => (
          <TabsContent value={section}>
            <Switch>
              <Match when={section === "appearance"}>
                <AppearanceSettings />
              </Match>
              <Match when={section === "application"}>
                <ApplicationSettings />
              </Match>
              <Match when={section === "notifications"}>
                <NotificationSettings />
              </Match>
              <Match when={section === "connection"}>
                <ConnectionSettings />
              </Match>
              <Match when={section === "transfer"}>
                <TransferSettings />
              </Match>
              <Match when={section === "meeting"}>
                <MeetingSettings />
              </Match>
              <Match when={section === "remote_control"}>
                <RemoteControlSettings />
              </Match>
              <Match when={section === "permissions"}>
                <PermissionsSettings />
              </Match>
              <Match when={section === "advanced"}>
                <AdvancedSettings />
              </Match>
              <Match when={section === "about"}>
                <AboutSettings />
              </Match>
            </Switch>
          </TabsContent>
        )}
      </For>
    </ResponsiveTabs>
  );
}
