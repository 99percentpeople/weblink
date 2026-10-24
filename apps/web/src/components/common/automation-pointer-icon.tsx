import type { JSX } from "solid-js";

export function AutomationPointerIcon(
  props: JSX.SvgSVGAttributes<SVGSVGElement>,
) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="2"
      stroke-linecap="round"
      stroke-linejoin="round"
      {...props}
    >
      {/* Preserve Lucide MousePointer2's original outline and rounded corners. */}
      <path d="M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z" />
      <path
        d="M19 1l.8 2.2L22 4l-2.2.8L19 7l-.8-2.2L16 4l2.2-.8Z"
        stroke-width="1.5"
      />
    </svg>
  );
}
