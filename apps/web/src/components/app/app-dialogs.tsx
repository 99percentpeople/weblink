import type { ParentProps } from "solid-js";
import {
  AppDialogsContext,
  type AppDialogs,
} from "@/libs/state/app-dialogs-context";
import { SystemNotificationBridge } from "./system-notifications";
export function AppDialogsView(props: ParentProps) {
  return (
    <SystemNotificationBridge>
      {props.children}
    </SystemNotificationBridge>
  );
}
export function AppDialogsProvider(
  props: ParentProps<{ value: AppDialogs }>,
) {
  return (
    <AppDialogsContext.Provider value={props.value}>
      <AppDialogsView>{props.children}</AppDialogsView>
    </AppDialogsContext.Provider>
  );
}
