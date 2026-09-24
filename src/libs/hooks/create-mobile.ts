import { createMemo } from "solid-js";
import { createWindowSize } from "@solid-primitives/resize-observer";
import { MOBILE_BREAKPOINT_PX } from "@/constants";

export function createIsMobile(
  viewport: Readonly<{
    width: number;
  }> = createWindowSize(),
) {
  // Use the same resize snapshot as surrounding responsive layouts. A media-query
  // or orientation event can arrive before innerWidth reflects the new viewport.
  return createMemo(
    () => viewport.width < MOBILE_BREAKPOINT_PX,
  );
}
