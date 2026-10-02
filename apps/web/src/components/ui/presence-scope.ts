import { createContext } from "solid-js";
export type ExitHandler = () => Promise<unknown>;
export const PresenceContext = createContext<{
  present(): boolean;
  register(exit: ExitHandler): () => void;
}>();
