import {
  createContext,
  type Accessor,
  type ParentProps,
} from "solid-js";
export type TileActionProps = ParentProps<{
  label: string;
  title?: string;
  active?: boolean;
  disabled?: boolean;
  order?: number;
  keepFocus?: boolean;
  onAction(): void;
}>;
export const ActionsContext = createContext<{
  compact: Accessor<boolean>;
  register(action: TileActionProps): () => void;
}>();
