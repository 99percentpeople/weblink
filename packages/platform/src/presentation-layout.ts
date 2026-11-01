/** WAAPI does not emit CSS animationstart/transitionrun events. Notify native
 * overlays after starting it so they can follow the DOM until it settles. */
export const PRESENTATION_LAYOUT_EVENT =
  "weblink:presentation-layout";

export function notifyPresentationLayout(element: Element) {
  const EventType =
    element.ownerDocument.defaultView?.Event ?? Event;
  element.dispatchEvent(
    new EventType(PRESENTATION_LAYOUT_EVENT, {
      bubbles: true,
    }),
  );
}
