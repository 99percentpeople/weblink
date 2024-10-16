import {
  Component,
  ComponentProps,
  JSX,
  Show,
} from "solid-js";
import { createDrawer } from "./dialogs/drawer";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from "./ui/context-menu";
import { createMediaQuery } from "@solid-primitives/media";

export interface PortableContextMenuProps {
  content: Component<ComponentProps<"">>;
  menu: (close: () => void) => JSX.Element;
}

export const PortableContextMenu: Component<
  PortableContextMenuProps
> = (props) => {
  const isMobile = createMediaQuery("(max-width: 768px)");
  const { open, close, Component } = createDrawer({
    content: () => (
      <div class="mx-4 mb-8">
        <ContextMenu>
          {props.menu(() => close())}
        </ContextMenu>
      </div>
    ),
  });

  const Child = props.content;

  return (
    <Show
      when={isMobile()}
      fallback={
        <ContextMenu>
          <ContextMenuTrigger
            as={Child}
          ></ContextMenuTrigger>
          <ContextMenuContent class="w-48">
            {props.menu(() => {})}
          </ContextMenuContent>
        </ContextMenu>
      }
    >
      <Child
        onContextMenu={(ev: MouseEvent) => {
          ev.preventDefault();
          open();
        }}
      />
      <Component />
    </Show>
  );
};
