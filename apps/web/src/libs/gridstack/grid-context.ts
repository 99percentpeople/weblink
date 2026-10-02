import { useContext } from "solid-js";
import { useViewScopes } from "@/libs/state/view-scopes";
export function useGridStackScope() {
  return useViewScopes().grid;
}
export function useGridStackContext() {
  const context = useContext(useGridStackScope());
  if (!context)
    throw new Error(
      "useGridStackContext must be used within a GridStackProvider",
    );
  return context;
}
