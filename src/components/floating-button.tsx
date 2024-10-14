import {
  ComponentProps,
  createEffect,
  createMemo,
  createSignal,
  Show,
  splitProps,
} from "solid-js";
import { Button } from "./ui/button";
import { cn } from "@/libs/cn";

export interface FloatingButtonProps
  extends ComponentProps<"button"> {
  isVisible: boolean;
  delay: number;
}

export const FloatingButton = (
  props: FloatingButtonProps,
) => {
  const [local, other] = splitProps(props, [
    "class",
    "delay",
    "isVisible",
  ]);

  const [isChanging, setIsChanging] =
    createSignal<boolean>(false);

  let timeout: number | undefined;
  const isVisible = createMemo(() => props.isVisible);
  createEffect(() => {
    setIsChanging(true);

    if (timeout) {
      window.clearTimeout(timeout);
      timeout = undefined;
    }
    if (isVisible()) {
      timeout = window.setTimeout(() => {
        setIsChanging(false);
      }, local.delay);
    } else {
      timeout = window.setTimeout(() => {
        setIsChanging(false);
      }, local.delay - 50);
    }
  });

  return (
    <Show when={isChanging() || props.isVisible}>
      <Button
        data-expanded={
          isChanging() && isVisible() ? true : undefined
        }
        data-closed={
          isChanging() && !isVisible() ? true : undefined
        }
        class={cn(local.class)}
        variant="secondary"
        size="icon"
        {...other}
      />
    </Show>
  );
};
