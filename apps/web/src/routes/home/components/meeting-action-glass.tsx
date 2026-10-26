import { createMemo, For } from "solid-js";
import type { ActionFanLayout } from "./meeting-action-fan";

const LAYERS = [
  { blur: 2, feather: 4, inset: 0 },
  { blur: 5, feather: 6, inset: 2 },
  { blur: 10, feather: 8, inset: 4 },
  { blur: 18, feather: 10, inset: 7 },
  { blur: 28, feather: 12, inset: 10 },
];
const BLEED = 32;

/** Fade stronger backdrop blur inward without blurring the controls. */
export function MeetingActionGlass(props: {
  shape: Pick<ActionFanLayout, "path" | "radius">;
}) {
  const masks = createMemo(() => {
    const { radius, path } = props.shape;
    const extent = radius + BLEED;
    return LAYERS.map(({ feather, inset }) => {
      // Stronger blur stays nearer the buttons. A continuous alpha curve and
      // extra canvas space let the soft edge fade beyond every contour.
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-extent} ${-extent} ${extent * 2} ${extent * 2}"><defs><filter id="edge" x="-50%" y="-50%" width="200%" height="200%"><feMorphology operator="erode" radius="${inset}"/><feGaussianBlur stdDeviation="${feather}"/><feComponentTransfer><feFuncA type="gamma" amplitude="1" exponent="1.4" offset="0"/></feComponentTransfer></filter></defs><path d="${path}" fill="white" filter="url(#edge)"/></svg>`;
      return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
    });
  });

  return (
    <span
      class="meeting-action-glass"
      aria-hidden="true"
      style={{
        "--glass-bleed": `${BLEED}px`,
      }}
    >
      <For each={LAYERS}>
        {(layer, index) => (
          <span
            class="meeting-action-glass-layer"
            style={{
              "--glass-blur": `${layer.blur}px`,
              "mask-image": masks()[index()],
            }}
          />
        )}
      </For>
    </span>
  );
}
