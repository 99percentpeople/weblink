import { Component, createSignal, JSX } from "solid-js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/libs/cn";
import {
  BaseModalProps,
  createModal,
  ModalProps,
} from "./base";

const BaseDialog: Component<BaseModalProps> = (props) => {
  return (
    <Dialog
      open={props.isOpen}
      onOpenChange={() => props.onClose()}
    >
      <DialogContent
        class={cn(
          "flex flex-col overflow-hidden",
          props.class,
        )}
      >
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>
            {props.description}
          </DialogDescription>
        </DialogHeader>
        {props.content}
        <DialogFooter>
          {props.cancel}
          {props.confirm}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface DialogProps<T>
  extends Omit<ModalProps<T>, "component"> {}

export const createDialog = <T extends any>(
  options: DialogProps<T>,
) => {
  return createModal({ ...options, component: BaseDialog });
};
