import { cn } from "@/libs/cn";
import {
  Component,
  createSignal,
  For,
  getOwner,
  JSX,
  onCleanup,
  ParentProps,
} from "solid-js";

export interface ModalOptions<T extends any> {
  class?: string;
  title?: () => JSX.Element;
  description?: () => JSX.Element;
  content?: Component;
  confirm?: JSX.Element;
  cancel?: JSX.Element;
  component: Component<BaseModalProps<T>>;
  onSubmit?: (data: T) => void;
  onCancel?: () => void;
}

export interface ReturnValue<T> {
  result?: T;
  cancel: boolean;
}

export interface BaseModalProps<T extends any> {
  class?: string;
  isOpen: boolean;
  title?: JSX.Element;
  description?: JSX.Element;
  content?: JSX.Element;
  confirm?: JSX.Element;
  cancel?: JSX.Element;
  onSubmit?: (data: T) => void;
  onCancel?: () => void;
}

type ModalRenderer = {
  id: number;
  render: () => JSX.Element;
};

const [modalRenderers, setModalRenderers] = createSignal<
  ModalRenderer[]
>([]);
let modalRendererId = 0;

export const mountModalRenderer = (
  render: () => JSX.Element,
) => {
  const id = ++modalRendererId;
  setModalRenderers((prev) => [
    ...prev,
    {
      id,
      render,
    },
  ]);

  const unmount = () => {
    setModalRenderers((prev) =>
      prev.filter((modal) => modal.id !== id),
    );
  };

  if (getOwner()) {
    onCleanup(unmount);
  }

  return unmount;
};

export const ModalProvider: Component<ParentProps> = (
  props,
) => {
  return (
    <>
      {props.children}
      <For each={modalRenderers()}>
        {(modal) => modal.render()}
      </For>
    </>
  );
};

export const createModal = <T extends any>(
  options: ModalOptions<T>,
) => {
  const [isOpen, setIsOpen] = createSignal<boolean>(false);
  const [reslovePromise, setResolovePromise] =
    createSignal<(value: ReturnValue<T>) => void>();

  const open = (): Promise<ReturnValue<T>> => {
    return new Promise<ReturnValue<T>>((reslove) => {
      setIsOpen(true);
      setResolovePromise(() => reslove);
    });
  };

  const close = () => {
    options.onCancel?.();
    reslovePromise()?.({
      result: undefined,
      cancel: true,
    });
    setIsOpen(false);
  };

  const submit = (data: T) => {
    options.onSubmit?.(data);
    setIsOpen(false);
    reslovePromise()?.({
      result: data,
      cancel: false,
    });
  };

  const Component = options.component;

  const renderContent = () => {
    try {
      return options.content?.({
        submit,
        close,
      });
    } catch (err) {
      console.error(err);
    }
  };

  const ModalComponent = (props: { class?: string }) => {
    return (
      <Component
        class={cn(options.class, props.class)}
        isOpen={isOpen()}
        title={options?.title?.()}
        content={renderContent()}
        description={options?.description?.()}
        confirm={options?.confirm}
        cancel={options?.cancel}
        onSubmit={options?.onSubmit}
        onCancel={close}
      />
    );
  };

  mountModalRenderer(() => <ModalComponent />);

  return {
    open,
    close,
    submit,
  };
};
