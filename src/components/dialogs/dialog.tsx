import { Component, createSignal, JSX } from "solid-js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { cn } from "@/libs/cn";
import {
  BaseModalProps,
  createModal,
  ModalProps,
} from "./base";

const BaseDialog: Component<BaseModalProps> = (props) => {
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
  //     props.onCancel()
  //   }
  // };
  return (
    <Dialog
      open={props.isOpen}
      onOpenChange={() => props.onClose()}
    >
      <DialogContent class={cn(props.class)}>
        <DialogHeader>
          {props.title && (
            <DialogTitle>{props.title}</DialogTitle>
          )}
          {props.description && (
            <DialogDescription>
              {props.description}
            </DialogDescription>
          )}
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
