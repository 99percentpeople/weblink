import {
  Component,
  ComponentProps,
  createSignal,
  Show,
  splitProps,
} from "solid-js";
import { Button } from "./ui/button";
import {
  IconContentCopy,
  IconContentPaste,
  IconInventory,
} from "./icons";
import { cn } from "@/libs/cn";

export const CopyToClipboard: Component<
  ComponentProps<"button">
> = (props) => {
  const [local, other] = splitProps(props, [
    "children",
    "class",
  ]);
  const [copied, setCopied] = createSignal<boolean>(false);
  let timer: number | undefined = undefined;

  const copyTheContent = () => {
    const content = (local.children as HTMLElement)
      .innerText;
    navigator.clipboard.writeText(content);
    setCopied(true);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      setCopied(false);
    }, 4000);
  };
  return (
    <>
      {local.children}
      <div>
        <Button
          class={cn("size-6", local.class)}
          variant="outline"
          size="icon"
          onClick={() => copyTheContent()}
          {...other}
        >
          <Show
            when={copied()}
            fallback={<IconContentPaste class="size-4" />}
          >
            <IconInventory class="size-4" />
          </Show>
        </Button>
      </div>
    </>
  );
};
