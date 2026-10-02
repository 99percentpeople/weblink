import { createContext, useContext } from "solid-js";
import { VideoContext } from "@/routes/home/components/video-display-scope";
import { ActionsContext } from "@/routes/home/components/meeting-tile-actions-scope";
import { PresenceContext } from "@/components/ui/presence-scope";
import { MotionLayoutContext } from "@/libs/hooks/motion-layout-scope";
import { GridStackContext } from "@/libs/gridstack/grid-scope";

/** Identities belong to the application; each view still provides its own scoped value. */
export const defaultViewScopes = Object.freeze({
  video: VideoContext,
  tileActions: ActionsContext,
  presence: PresenceContext,
  motionLayout: MotionLayoutContext,
  grid: GridStackContext,
});
export type ViewScopes = typeof defaultViewScopes;
// The default also supports standalone views and independently mounted test roots.
export const ViewScopesContext = createContext(
  defaultViewScopes,
);
export const useViewScopes = (): ViewScopes =>
  useContext(ViewScopesContext);
