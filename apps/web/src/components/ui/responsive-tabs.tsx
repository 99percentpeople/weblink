import type { TabsRootProps } from "@kobalte/core/tabs";
import { splitProps, type ParentProps } from "solid-js";
import { cn } from "@/libs/cn";
import { createIsMobile } from "@/libs/hooks/create-mobile";
import { Tabs } from "./tabs";
import "./responsive-tabs.css";

/** Sidebar navigation on wide screens, scrollable tabs on narrow screens. */
export function ResponsiveTabs(
  props: ParentProps<
    Omit<TabsRootProps, "orientation"> & {
      class?: string;
    }
  >,
) {
  const [local, rest] = splitProps(props, ["class"]);
  const isMobile = createIsMobile();
  return (
    <Tabs
      {...rest}
      class={cn("responsive-tabs", local.class)}
      orientation={isMobile() ? "horizontal" : "vertical"}
    />
  );
}
