import {
  Show,
  splitProps,
  type JSX,
  type ParentProps,
} from "solid-js";
import { X } from "lucide-solid";
import { cn } from "@/libs/cn";

type ToastContentProps = Omit<
  JSX.HTMLAttributes<HTMLElement>,
  "title"
> & {
  title: JSX.Element;
  status?: boolean;
  trailing?: JSX.Element;
};

/** Rich notices share the same title, body and action styles as ordinary toasts. */
export function ToastContent(props: ToastContentProps) {
  const [local, rest] = splitProps(props, [
    "title",
    "status",
    "trailing",
    "children",
    "class",
  ]);
  return (
    <section
      {...rest}
      class={cn("toast-content", local.class)}
    >
      <div class="toast-header">
        <div
          class="toast-heading"
          role={local.status ? "status" : undefined}
        >
          {local.title}
        </div>
        <Show when={local.trailing}>
          {(trailing) => (
            <div class="toast-trailing">{trailing()}</div>
          )}
        </Show>
      </div>
      <div class="toast-body">{local.children}</div>
    </section>
  );
}

export function ToastActions(props: ParentProps) {
  return <div data-toast-actions>{props.children}</div>;
}

type ToastButtonProps =
  JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: "primary" | "secondary" | "destructive";
  };

/** Custom actions retain their own dismissal and cancellation behavior. */
export function ToastButton(props: ToastButtonProps) {
  const [local, rest] = splitProps(props, ["variant"]);
  return (
    <button
      type="button"
      {...rest}
      data-button
      data-action={
        (local.variant ?? "primary") === "primary"
          ? ""
          : undefined
      }
      data-cancel={
        local.variant === "secondary" ? "" : undefined
      }
      data-destructive={
        local.variant === "destructive" ? "" : undefined
      }
    />
  );
}

export function ToastDismissButton(
  props: Omit<
    JSX.ButtonHTMLAttributes<HTMLButtonElement>,
    "children"
  > & {
    "aria-label": string;
  },
) {
  return (
    <button type="button" data-toast-dismiss {...props}>
      <X aria-hidden="true" />
    </button>
  );
}
