import { PRESENTATION_LAYOUT_EVENT } from "@weblink/platform";

/** Measure only on invalidation; keep RAF alive while an ancestor animates.
 * Decoded frames do not change DOM geometry and must not wake this observer. */
export function observePresentationLayout(
  video: HTMLVideoElement,
  update: () => void,
) {
  const doc = video.ownerDocument;
  const view = doc.defaultView!;
  const lifetime = new AbortController();
  let stopped = false;
  let raf = 0;
  let ancestors: Element[] = [];
  const resize = new ResizeObserver(() => request());
  const connect = () => {
    const next: Element[] = [];
    for (
      let node: Element | null = video;
      node;
      node = node.parentElement
    )
      next.push(node);
    if (
      next.length === ancestors.length &&
      next.every((node, index) => node === ancestors[index])
    )
      return;
    resize.disconnect();
    ancestors = next;
    for (const node of ancestors) resize.observe(node);
  };
  const animating = () =>
    video.isConnected &&
    !doc.hidden &&
    ancestors.some((node) =>
      node
        .getAnimations?.()
        .some(
          (animation) =>
            animation.pending ||
            animation.playState === "running",
        ),
    );
  const refresh = () => {
    if (stopped) return;
    view.cancelAnimationFrame(raf);
    raf = 0;
    connect();
    update();
    if (animating()) request();
  };
  function request() {
    if (!stopped && !raf)
      raf = view.requestAnimationFrame(refresh);
  }
  const affectsVideo = (target: Node) =>
    target.contains(video) ||
    !!target.parentElement?.contains(video);
  const mutations = new MutationObserver((records) => {
    if (
      records.some(
        (record) =>
          affectsVideo(record.target) ||
          // A removed/reparented tile no longer has its old ancestors.
          [...record.removedNodes].some((node) =>
            node.contains(video),
          ),
      )
    )
      request();
  });
  mutations.observe(doc.documentElement, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["class", "style", "hidden", "open"],
  });
  const options = { signal: lifetime.signal };
  for (const event of [
    "scroll",
    "transitionrun",
    "transitionend",
    "transitioncancel",
    "animationstart",
    "animationend",
    "animationcancel",
    PRESENTATION_LAYOUT_EVENT,
  ])
    doc.addEventListener(
      event,
      (event) => {
        if (
          event.target instanceof Node &&
          affectsVideo(event.target)
        )
          request();
      },
      { ...options, capture: true },
    );
  // Visibility must reach the native plane even when background RAF is paused.
  doc.addEventListener(
    "visibilitychange",
    refresh,
    options,
  );
  doc.addEventListener(
    "fullscreenchange",
    refresh,
    options,
  );
  view.addEventListener("resize", request, options);
  view.visualViewport?.addEventListener(
    "resize",
    request,
    options,
  );
  view.visualViewport?.addEventListener(
    "scroll",
    request,
    options,
  );
  video.addEventListener("resize", request, options);
  refresh();
  return {
    refresh,
    request,
    close() {
      if (stopped) return;
      stopped = true;
      lifetime.abort();
      view.cancelAnimationFrame(raf);
      mutations.disconnect();
      resize.disconnect();
      ancestors = [];
    },
  };
}
