import type {
  Component,
  JSX,
  ValidComponent,
} from "solid-js";
import { splitProps } from "solid-js";

import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import * as ProgressPrimitive from "@kobalte/core/progress";

type ProgressRootProps<T extends ValidComponent = "div"> =
  ProgressPrimitive.ProgressRootProps<T> & {
    children?: JSX.Element;
  };

const Progress = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, ProgressRootProps<T>>,
) => {
  const [local, others] = splitProps(
    props as ProgressRootProps,
    ["children"],
  );
  return (
    <ProgressPrimitive.Root {...others}>
      {local.children}
      <ProgressPrimitive.Track
        class="bg-secondary relative h-2 w-full overflow-hidden
          rounded-full"
      >
        <ProgressPrimitive.Fill
          class="bg-primary h-full w-[var(--kb-progress-fill-width)] flex-1
            transition-all"
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
};

const ProgressLabel: Component<
  ProgressPrimitive.ProgressLabelProps
> = (props) => {
  return <ProgressPrimitive.Label {...props} />;
};

const ProgressValueLabel: Component<
  ProgressPrimitive.ProgressValueLabelProps
> = (props) => {
  return <ProgressPrimitive.ValueLabel {...props} />;
};

export { Progress, ProgressLabel, ProgressValueLabel };
