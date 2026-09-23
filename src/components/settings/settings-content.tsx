import { For, Match, Switch } from "solid-js";
import {
  Tabs,
  TabsContent,
  TabsIndicator,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { createIsMobile } from "@/libs/hooks/create-mobile";
import { t } from "@/i18n";
import AppearanceSettings from "./appearance-settings";
import { ConnectionSettings } from "./connection-settings";
import TransferSettings from "./transfer-settings";
import AdvancedSettings from "./advanced-settings";
import AboutSettings from "./about-settings";

export const settingsSections = [
  "appearance",
  "connection",
  "transfer",
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
  const isMobile = createIsMobile();
  return (
    <Tabs
      class="settings-tabs"
      orientation={isMobile() ? "horizontal" : "vertical"}
      value={props.section}
      onChange={(value) =>
        props.onSectionChange(value as SettingsSection)
      }
    >
      <TabsList
        class="settings-categories"
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
          <TabsContent
            value={section}
            class="settings-content"
          >
            <Switch>
              <Match when={section === "appearance"}>
                <AppearanceSettings />
              </Match>
              <Match when={section === "connection"}>
                <ConnectionSettings />
              </Match>
              <Match when={section === "transfer"}>
                <TransferSettings />
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
    </Tabs>
  );
}
