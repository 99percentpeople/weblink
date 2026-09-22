// Replaces only the context lookup in the isolated browser UI fixture.
// The real task service, speed-test driver, dialogs and tabs are used unchanged.
import type { AppStateContextProps } from "@/libs/state/app-state-context";
let context: AppStateContextProps;
export const setTaskTestContext = (
  value: AppStateContextProps,
) => {
  context = value;
};
export const useAppState = () => context;
