import { Component } from "solid-js";
import {
  Dialog,
  DialogBody,
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
  ModalOptions,
} from "./base";

export const BaseDialog: Component<BaseModalProps<any>> = (
  props,
) => {
  return (
    <Dialog
      open={props.isOpen}
      onOpenChange={() => props.onCancel?.()}
    >
      <DialogContent
        class={cn("flex flex-col", props.class)}
      >
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>
            {props.description}
          </DialogDescription>
        </DialogHeader>
        <DialogBody>{props.content}</DialogBody>
        <DialogFooter>
          {props.cancel}
          {props.confirm}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

interface DialogProps<T> extends Omit<
  ModalOptions<T>,
  "component"
> {}

export const createDialog = <T extends any>(
  options: DialogProps<T>,
) => {
  return createModal<T>({
    ...options,
    component: BaseDialog,
  });
};
