import type { ParentProps } from "solid-js";
import { platform } from "@/libs/platform/runtime";
import { createAppSettings } from "@/libs/state/create-app-settings";
import {
  AppStateContext,
  type AppStateContextProps,
} from "@/libs/state/app-state-context";

export function SettingsStateProvider(props: ParentProps) {
  const settings = createAppSettings({
    platform,
    permissions: {
      devices: () => [],
      state: () => "prompt",
    },
    stream: () => null,
  });
  return (
    <AppStateContext.Provider
      value={settings as AppStateContextProps}
    >
      {props.children}
    </AppStateContext.Provider>
  );
}
