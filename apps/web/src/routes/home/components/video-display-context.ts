import { useContext } from "solid-js";
import { useViewScopes } from "@/libs/state/view-scopes";
export const useVideoDisplay = () => {
  const context = useContext(useViewScopes().video);
  if (!context)
    throw new Error(
      "useVideoDisplay must be used within a VideoDisplay",
    );
  return context;
};
