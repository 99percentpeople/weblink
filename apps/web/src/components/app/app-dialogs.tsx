import type { ParentProps } from "solid-js";
import {
  AppDialogsContext,
  type AppDialogs,
} from "@/libs/state/app-dialogs-context";
import { SystemNotificationBridge } from "./system-notifications";
export function AppDialogsView() {
  return <SystemNotificationBridge />;
}
export function AppDialogsProvider(
  props: ParentProps<{ value: AppDialogs }>,
) {
  return (
    <AppDialogsContext.Provider value={props.value}>
      {props.children}
      <AppDialogsView />
    </AppDialogsContext.Provider>
  );
}
