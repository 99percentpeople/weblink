import { createContext } from "solid-js";
import type { createMotionLayoutRegistry } from "./motion-layout-registry";
export const MotionLayoutContext =
  createContext<
    ReturnType<typeof createMotionLayoutRegistry>
  >();
