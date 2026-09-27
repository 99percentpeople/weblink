import {
  createContext,
  onCleanup,
  useContext,
  type Accessor,
} from "solid-js";

export interface MotionLayoutOptions {
  layout?: boolean | "height";
  layoutId?: string;
  layoutScroll?: boolean;
  layoutContainer?: boolean;
  layoutSize?: string;
  layoutOverlay?: string;
}

export interface MotionLayoutNode {
  key: symbol;
  element: HTMLElement;
  options: Accessor<MotionLayoutOptions>;
  present: Accessor<boolean>;
}

export function createMotionLayoutRegistry() {
  const nodes = new Set<MotionLayoutNode>();
  onCleanup(() => nodes.clear());
  return {
    nodes: nodes as ReadonlySet<MotionLayoutNode>,
    register(node: Omit<MotionLayoutNode, "key">) {
      const entry = { ...node, key: Symbol() };
      nodes.add(entry);
      return () => nodes.delete(entry);
    },
  };
}

export const MotionLayoutContext =
  createContext<
    ReturnType<typeof createMotionLayoutRegistry>
  >();

/** Create in the element's Solid owner; repeated ref calls replace the registration. */
export function createMotionLayoutRef(
  options: Accessor<MotionLayoutOptions>,
  present: Accessor<boolean> = () => true,
) {
  const registry = useContext(MotionLayoutContext);
  let unregister: (() => void) | undefined;
  onCleanup(() => unregister?.());
  return (element: HTMLElement) => {
    unregister?.();
    unregister = registry?.register({
      element,
      options,
      present,
    });
  };
}

/** Native-element directive; composes with the caller's existing ref. */
export function layoutScroll(
  element: HTMLElement,
  enabled: Accessor<boolean>,
) {
  createMotionLayoutRef(() => ({
    layoutScroll: enabled(),
  }))(element);
}

export function layoutContainer(
  element: HTMLElement,
  enabled: Accessor<boolean>,
) {
  createMotionLayoutRef(() => ({
    layoutContainer: enabled(),
  }))(element);
}

export function layoutSize(
  element: HTMLElement,
  id: Accessor<string>,
) {
  createMotionLayoutRef(() => ({ layoutSize: id() }))(
    element,
  );
}

export function layoutOverlay(
  element: HTMLElement,
  id: Accessor<string>,
) {
  createMotionLayoutRef(() => ({ layoutOverlay: id() }))(
    element,
  );
}

declare module "solid-js" {
  namespace JSX {
    interface Directives {
      layoutScroll: boolean;
      layoutContainer: boolean;
      layoutSize: string;
      layoutOverlay: string;
    }
  }
}
