import type { ParentProps } from "solid-js";
import { createAppDialogs } from "@/libs/state/create-app-dialogs";
import { AppDialogsProvider as InjectDialogs } from "@/components/app/app-dialogs";

export function AppDialogsProvider(props: ParentProps) {
  const value = createAppDialogs();
  return (
    <InjectDialogs value={value}>
      {props.children}
    </InjectDialogs>
  );
}
