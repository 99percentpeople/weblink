/** Keep the DOM control/label layer intact; cut holes only in page backgrounds
 * and the black video placeholder. The HWND compositor sits below WebView2. */
export interface SurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
  radius: number;
}
function path(rect: SurfaceRect) {
  const { x, y, width: w, height: h } = rect;
  const r = Math.min(rect.radius, w / 2, h / 2);
  return `M${x + r},${y}h${w - 2 * r}q${r},0 ${r},${r}v${h - 2 * r}q0,${r} ${-r},${r}h${2 * r - w}q${-r},0 ${-r},${-r}v${2 * r - h}q0,${-r} ${r},${-r}Z`;
}
function mask(
  width: number,
  height: number,
  holes: SurfaceRect[],
) {
  const cuts = holes
    .map((rect) => `<path fill="black" d="${path(rect)}"/>`)
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><mask id="cut" mask-type="luminance"><rect width="100%" height="100%" fill="white"/>${cuts}</mask><rect width="100%" height="100%" fill="white" mask="url(#cut)"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
export function createPresentationLayout() {
  const holes = new Map<symbol, SurfaceRect>();
  const masks = new Map<symbol, string>();
  let base: HTMLDivElement | undefined;
  let viewport = "";
  const update = () => {
    viewport = `${innerWidth},${innerHeight}`;
    document.documentElement.classList.toggle(
      "native-video-active",
      holes.size > 0,
    );
    if (holes.size && !base) {
      base = document.createElement("div");
      base.className = "native-video-background";
      document.body.prepend(base);
    }
    if (!holes.size) {
      base?.remove();
      base = undefined;
    }
    document.documentElement.style.setProperty(
      "--native-video-mask",
      mask(innerWidth, innerHeight, [...holes.values()]),
    );
  };
  return {
    show(
      key: symbol,
      video: HTMLVideoElement,
      rect: SurfaceRect,
    ) {
      const box = video.getBoundingClientRect();
      const local = {
        ...rect,
        x: rect.x - box.x,
        y: rect.y - box.y,
      };
      const signature = JSON.stringify([
        local,
        box.width,
        box.height,
      ]);
      video.dataset.nativeVideo = "true";
      if (masks.get(key) !== signature) {
        masks.set(key, signature);
        video.style.maskImage = mask(
          box.width,
          box.height,
          [local],
        );
      }
      if (
        JSON.stringify(holes.get(key)) ===
          JSON.stringify(rect) &&
        viewport === `${innerWidth},${innerHeight}`
      )
        return;
      holes.set(key, rect);
      update();
    },
    hide(key: symbol, video: HTMLVideoElement) {
      if (!holes.delete(key)) return;
      masks.delete(key);
      delete video.dataset.nativeVideo;
      video.style.removeProperty("mask-image");
      update();
    },
  };
}
