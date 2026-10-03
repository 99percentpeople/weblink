import type { TouchSample } from "./touch-types";

/** Real historical samples only; predicted positions must never drive remote input. */
export function touchMovementSamples(
  event: PointerEvent,
): readonly PointerEvent[] {
  const samples = event.getCoalescedEvents?.();
  return samples?.length ? samples : [event];
}

export function touchSample(
  event: Pick<
    PointerEvent,
    "pressure" | "width" | "height"
  >,
  position: { x: number; y: number },
  size: { width: number; height: number },
  forwardProperties: boolean,
): TouchSample {
  const sample: TouchSample = { ...position };
  if (!forwardProperties) return sample;
  if (
    Number.isFinite(event.pressure) &&
    event.pressure >= 0 &&
    event.pressure <= 1
  )
    sample.pressure = event.pressure;
  if (
    Number.isFinite(event.width) &&
    Number.isFinite(event.height) &&
    event.width > 0 &&
    event.height > 0 &&
    // Browsers report 1 x 1 when the device does not expose contact geometry.
    (event.width !== 1 || event.height !== 1) &&
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  ) {
    sample.width = Math.min(1, event.width / size.width);
    sample.height = Math.min(1, event.height / size.height);
  }
  return sample;
}
