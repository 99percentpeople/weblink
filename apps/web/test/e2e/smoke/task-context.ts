// Replaces only the context lookup in the isolated browser UI fixture.
// The real task service, speed-test driver, dialogs and tabs are used unchanged.
import type { AppStateContextProps } from "@/libs/state/app-state-context";
import { clipboardFixture } from "./clipboard-context";
let context: AppStateContextProps;
export const setTaskTestContext = (
  value: Omit<AppStateContextProps, "remoteClipboard">,
) => {
  context = { ...value, remoteClipboard: clipboardFixture };
};
export const useAppState = () => context;
