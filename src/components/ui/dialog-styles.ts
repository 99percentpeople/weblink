import { cn } from "@/libs/cn";

export function getDialogContentClassName(
  className?: string,
): string {
  return cn(
    `bg-background data-[expanded]:animate-in
    data-[closed]:animate-out data-[closed]:fade-out-0
    data-[expanded]:fade-in-0 data-[closed]:zoom-out-95
    data-[expanded]:zoom-in-95 fixed top-1/2 left-1/2 z-50 grid
    max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)]
    -translate-x-1/2 -translate-y-1/2 gap-4 overflow-hidden
    rounded-lg border p-6 shadow-lg duration-200 sm:max-w-lg`,
    className,
  );
}

export function getDialogBodyClassName(
  className?: string,
): string {
  return cn(
    "min-h-0 overflow-y-auto overscroll-contain",
    className,
  );
}
