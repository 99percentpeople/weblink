import { createContext, useContext } from "solid-js";
import type { createAppDialogs } from "./create-app-dialogs";
export type AppDialogs = ReturnType<
  typeof createAppDialogs
>;
export const AppDialogsContext =
  createContext<AppDialogs>();
export function useAppDialogs(): AppDialogs {
  const dialogs = useContext(AppDialogsContext);
  if (!dialogs)
    throw new Error("AppDialogsProvider is missing");
  return dialogs;
}
