import type { Accessor, ParentProps } from "solid-js";
import {
  createLayoutTransition,
  createLayoutValue,
} from "@/libs/hooks/layout-transition";
import {
  createMotionLayoutRegistry,
  MotionLayoutContext,
} from "@/libs/hooks/motion-layout-registry";

export {
  createMotionLayoutRef,
  layoutScroll,
  layoutContainer,
  layoutSize,
  layoutOverlay,
} from "@/libs/hooks/motion-layout-registry";

export function createMotionLayout(
  options: {
    root?: Accessor<HTMLElement | undefined>;
    afterUpdate?: () => void;
  } = {},
) {
  const registry = createMotionLayoutRegistry();
  const transition = createLayoutTransition(
    registry,
    options,
  );
  return {
    registry,
    transition,
    value<T>(source: Accessor<T>): Accessor<T> {
      return createLayoutValue(source, transition);
    },
  };
}

export function MotionLayout(
  props: ParentProps<{
    value: ReturnType<typeof createMotionLayout>;
  }>,
) {
  return (
    <MotionLayoutContext.Provider
      value={props.value.registry}
    >
      {props.children}
    </MotionLayoutContext.Provider>
  );
}
