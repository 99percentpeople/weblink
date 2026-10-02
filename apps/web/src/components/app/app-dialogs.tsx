import type { ParentProps } from "solid-js";
import {
  AppDialogsContext,
  type AppDialogs,
} from "@/libs/state/app-dialogs-context";
import { RemoteControlStatus } from "./remote-control-status";
export function AppDialogsView() {
  return (
    <>
      <RemoteControlStatus />
    </>
  );
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
