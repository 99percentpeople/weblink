import {
  createMemo,
  createUniqueId,
  splitProps,
} from "solid-js";
import type { ComponentProps } from "solid-js";
import { BRAND, getBrandArtwork } from "@/branding/brand";
import { cn } from "@/libs/cn";

type BrandProps = Omit<
  ComponentProps<"svg">,
  "children" | "innerHTML"
> & {
  variant?: "icon" | "logo" | "mark";
  decorative?: boolean;
};

/** Inline SVG preserves currentColor and the app's loaded Inter font. */
export function Brand(props: BrandProps) {
  const [local, rest] = splitProps(props, [
    "variant",
    "decorative",
    "class",
  ]);
  const prefix = `wl-instance-${createUniqueId().replace(/[^A-Za-z0-9_-]/g, "-")}`;
  const artwork = createMemo(() =>
    getBrandArtwork(local.variant ?? "logo", prefix),
  );
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={artwork().viewBox}
      fill="none"
      role={local.decorative ? undefined : "img"}
      aria-label={local.decorative ? undefined : BRAND.name}
      aria-hidden={local.decorative ? true : undefined}
      tabIndex={-1}
      class={cn("block h-10 w-auto shrink-0", local.class)}
      data-brand-variant={local.variant ?? "logo"}
      {...rest}
      // Only trusted, locally defined artwork is inserted here.
      innerHTML={artwork().markup}
    />
  );
}
