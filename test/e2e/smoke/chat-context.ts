// Only replace the application context: chat, history, layout and observers are real.
import type { AppStateContextProps } from "@/libs/state/app-state-context";
let context: AppStateContextProps;
export const setChatTestContext = (
  value: AppStateContextProps,
) => {
  context = value;
};
export const useAppState = () => context;
