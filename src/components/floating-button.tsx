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
  duration: number;
}

export const FloatingButton = (
  props: FloatingButtonProps,
) => {
  const [local, other] = splitProps(props, [
    "class",
    "duration",
    "isVisible",
    "delay",
  ]);

  const [isChanging, setIsChanging] =
    createSignal<boolean>(false);

  let timeout: number | undefined;
  const [isVisible, setIsVisible] = createSignal(
    props.isVisible,
  );

  createEffect(() => {
    if (isVisible() !== props.isVisible) {
      setTimeout(() => {
        setIsVisible(props.isVisible);
      }, local.delay ?? 0);
    }
  });

  createEffect(() => {
    setIsChanging(true);

    if (timeout) {
      window.clearTimeout(timeout);
      timeout = undefined;
    }
    if (isVisible()) {
      timeout = window.setTimeout(() => {
        setIsChanging(false);
      }, local.duration);
    } else {
      timeout = window.setTimeout(() => {
        setIsChanging(false);
      }, local.duration - 50);
    }
  });

  return (
    <Show when={isChanging() || isVisible()}>
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
