import { createMemo } from "solid-js";
import type { ActionFanLayout } from "./meeting-action-fan";

const BLEED = 32;

/** One translucent surface for browser and native video alike. */
export function MeetingActionGlass(props: {
  shape: Pick<ActionFanLayout, "path" | "radius">;
}) {
  const mask = createMemo(() => {
    const { radius, path } = props.shape;
    const extent = radius + BLEED;
    // Feather only the static alpha contour; never sample or filter video pixels.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-extent} ${-extent} ${extent * 2} ${extent * 2}"><defs><filter id="edge" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="8"/></filter></defs><path d="${path}" fill="white" filter="url(#edge)"/></svg>`;
    return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  });

  return (
    <span
      class="meeting-action-glass"
      aria-hidden="true"
      style={{
        "--glass-bleed": `${BLEED}px`,
      }}
    >
      <span
        class="meeting-action-glass-layer"
        style={{ "mask-image": mask() }}
      />
    </span>
  );
}
