import { createIsMobile } from "@/libs/hooks/create-mobile";
import { useColorMode } from "@kobalte/core";
import type {
  Component,
  ComponentProps,
  JSX,
} from "solid-js";

import { Toaster as Sonner } from "solid-sonner";

type ToasterProps = ComponentProps<typeof Sonner>;

const Toaster: Component<ToasterProps> = (props) => {
  const { colorMode } = useColorMode();
  const isMobile = createIsMobile();
  return (
    <Sonner
      theme={colorMode()}
      className="toaster group [&_*[data-content]]:flex-1"
      position={isMobile() ? "top-center" : "bottom-right"}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
        } as JSX.CSSProperties
      }
      toastOptions={{
        cancelButtonStyle: {
          "background-color": "var(--destructive)",
          color: "var(--destructive-foreground)",
        } as JSX.CSSProperties,
      }}
      {...props}
    />
  );
};

export { Toaster };
