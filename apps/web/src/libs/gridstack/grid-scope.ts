import type { GridStack as GridStackC } from "gridstack";
import { createContext } from "solid-js";

export const GridStackContext = createContext<{
  grid: GridStackC;
}>();
