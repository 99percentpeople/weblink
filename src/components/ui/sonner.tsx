import {
  IconCheck,
  IconClose,
  IconInfo,
} from "@/components/icons";
import { cn } from "@/libs/cn";
import { useColorMode } from "@kobalte/core";
import IconError from "@material-symbols/svg-400/outlined/error.svg?component-solid";
import IconWarning from "@material-symbols/svg-400/outlined/warning.svg?component-solid";
import type {
  Component,
  ComponentProps,
  JSX,
} from "solid-js";
import { mergeProps, splitProps } from "solid-js";

import { Toaster as Sonner } from "solid-sonner";
import "./sonner.css";

type ToasterProps = ComponentProps<typeof Sonner>;

const Toaster: Component<ToasterProps> = (props) => {
  const [local, rest] = splitProps(props, [
    "className",
    "position",
  ]);
  const mergedProps = mergeProps(
    { position: "top-center" as const },
    local,
  );
  const { colorMode } = useColorMode();
  return (
    <Sonner
      theme={colorMode()}
      className={cn("toaster", local.className)}
      position={mergedProps.position}
      icons={{
        success: <IconCheck aria-hidden="true" />,
        info: <IconInfo aria-hidden="true" />,
        warning: <IconWarning aria-hidden="true" />,
        error: <IconError aria-hidden="true" />,
        close: <IconClose aria-hidden="true" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as JSX.CSSProperties
      }
      {...rest}
    />
  );
};

export { Toaster };
