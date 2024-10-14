import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer";
import { Component, createSignal } from "solid-js";
import {
  BaseModalProps,
  createModal,
  ModalProps,
} from "./base";
import { cn } from "@/libs/cn";
import { Button } from "../ui/button";

const BaseDrawer: Component<BaseModalProps> = (props) => {
  const [isSubmitting, setIsSubmitting] =
    createSignal<boolean>(false);
  // const handleConfirm = async () => {
  //   if (props.onConfirm) {
  //     setIsSubmitting(true);
  //     let result: any = null;
  //     try {
  //       result = await props.onConfirm();
  //       props.onClose(result);
  //     } catch (err) {
  //     } finally {
  //       setIsSubmitting(false);
  //     }
  //   } else {
  //     props.onCancel();
  //   }
  // };

  return (
    <Drawer
      open={props.isOpen}
      closeOnOutsidePointerStrategy="pointerdown"
      onOpenChange={() => props.onClose()}
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
  extends Omit<ModalProps<T>, "component"> {}

export const createDrawer = <T extends any>(
  options: DrawerProps<T>,
) => {
  return createModal({ ...options, component: BaseDrawer });
};
