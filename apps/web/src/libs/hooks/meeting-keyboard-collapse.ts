import { createSignal } from "solid-js";
import { appState } from "@/libs/state/app-state";

/** A temporary view override; the user's manual collapse preferences stay intact. */
export function createMeetingKeyboardCollapse() {
  const [visible, setVisible] = createSignal(false);
  return {
    setVisible,
    collapsed: () =>
      visible() &&
      appState.options.remoteKeyboard.collapseControls ===
        true,
  };
}
