import { createContext, useContext } from "solid-js";
import type { createRoomActions } from "@/libs/state/create-room-actions";
export type RoomActions = ReturnType<
  typeof createRoomActions
>;
export const RoomActionsContext =
  createContext<RoomActions>();
export function useRoomActions(): RoomActions {
  const actions = useContext(RoomActionsContext);
  if (!actions)
    throw new Error("RoomActionsProvider is missing");
  return actions;
}
