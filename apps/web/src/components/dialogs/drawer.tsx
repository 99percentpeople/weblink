import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "@/components/ui/drawer";
import { Component } from "solid-js";
import {
  BaseModalProps,
  createModal,
  ModalOptions,
} from "./base";
import { cn } from "@/libs/cn";

const BaseDrawer: Component<BaseModalProps<any>> = (
  props,
) => {
  return (
    <Drawer
      noOutsidePointerEvents={false}
      open={props.isOpen}
      closeOnOutsidePointerStrategy="pointerdown"
      onOpenChange={() => props.onCancel?.()}
    >
      <DrawerContent class={cn(props.class)}>
        <DrawerHeader>
          {props.title && (
            <DrawerTitle>{props.title}</DrawerTitle>
          )}
          {props.description && (
            <DrawerDescription>
              {props.description}
            </DrawerDescription>
          )}
        </DrawerHeader>
        {props.content}
        <DrawerFooter>
          {props.cancel}
          {props.confirm}
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
};

interface DrawerProps<T>
  extends Omit<ModalOptions<T>, "component"> {}

export const createDrawer = <T extends any>(
  options: DrawerProps<T>,
) => {
  return createModal<T>({
    ...options,
    component: BaseDrawer,
  });
};
