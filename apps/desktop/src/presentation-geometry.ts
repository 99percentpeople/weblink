/** Read layout before writing masks. CSS clips belong to the container, not
 * to the aspect-fitted image inside its black letterbox/pillarbox area. */
export interface SurfaceRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
type Corner = readonly [number, number];
export interface SurfaceClip extends SurfaceRect {
  corners: readonly [Corner, Corner, Corner, Corner];
}
const pixels = (value: string) => parseFloat(value) || 0;
function size(
  element: Element,
  style: CSSStyleDeclaration,
  box: DOMRect,
) {
  const borderBox = style.boxSizing === "border-box";
  return {
    width:
      pixels(style.width) +
        (borderBox
          ? 0
          : pixels(style.paddingLeft) +
            pixels(style.paddingRight) +
            pixels(style.borderLeftWidth) +
            pixels(style.borderRightWidth)) ||
      (element as HTMLElement).offsetWidth ||
      box.width,
    height:
      pixels(style.height) +
        (borderBox
          ? 0
          : pixels(style.paddingTop) +
            pixels(style.paddingBottom) +
            pixels(style.borderTopWidth) +
            pixels(style.borderBottomWidth)) ||
      (element as HTMLElement).offsetHeight ||
      box.height,
  };
}
function clip(
  element: Element,
  style: CSSStyleDeclaration,
): SurfaceClip {
  const box = element.getBoundingClientRect();
  const local = size(element, style, box);
  const sx = local.width ? box.width / local.width : 0;
  const sy = local.height ? box.height / local.height : 0;
  const l = pixels(style.borderLeftWidth);
  const t = pixels(style.borderTopWidth);
  const r = pixels(style.borderRightWidth);
  const b = pixels(style.borderBottomWidth);
  const radius = (value: string): Corner => {
    const [x = "0", y = x] = (value || "0").split(/\s+/);
    const resolve = (v: string, length: number) =>
      pixels(v) * (v.endsWith("%") ? length / 100 : 1);
    return [
      resolve(x, local.width),
      resolve(y, local.height),
    ];
  };
  const [tl, tr, br, bl] = [
    style.borderTopLeftRadius,
    style.borderTopRightRadius,
    style.borderBottomRightRadius,
    style.borderBottomLeftRadius,
  ].map(radius) as [Corner, Corner, Corner, Corner];
  // CSS scales overlapping outer radii before deriving the padding-edge clip.
  const factor = Math.min(
    1,
    local.width / (tl[0] + tr[0] || 1),
    local.width / (bl[0] + br[0] || 1),
    local.height / (tl[1] + bl[1] || 1),
    local.height / (tr[1] + br[1] || 1),
  );
  const inner = (
    v: Corner,
    x: number,
    y: number,
  ): Corner => [
    Math.max(0, v[0] * factor - x) * sx,
    Math.max(0, v[1] * factor - y) * sy,
  ];
  const result: SurfaceClip = {
    x: box.x + l * sx,
    y: box.y + t * sy,
    width: Math.max(0, box.width - (l + r) * sx),
    height: Math.max(0, box.height - (t + b) * sy),
    corners: [
      inner(tl, l, t),
      inner(tr, r, t),
      inner(br, r, b),
      inner(bl, l, b),
    ],
  };
  if (style.overflowX === "visible") {
    result.x = 0;
    result.width = innerWidth;
    result.corners = [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ];
  }
  if (style.overflowY === "visible") {
    result.y = 0;
    result.height = innerHeight;
    result.corners = [
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
    ];
  }
  return result;
}
export function readPresentationGeometry(
  video: HTMLVideoElement,
  width: number,
  height: number,
) {
  const box = video.getBoundingClientRect();
  const style = getComputedStyle(video);
  const local = size(video, style, box);
  // Fit before the tile's FLIP transform; non-uniform animation scaling must
  // move the placeholder mask and the GPU image through the same coordinates.
  const scale =
    width > 0 && height > 0
      ? Math.min(local.width / width, local.height / height)
      : 0;
  const image: SurfaceRect = {
    x: (local.width - width * scale) / 2,
    y: (local.height - height * scale) / 2,
    width: width * scale,
    height: height * scale,
  };
  const sx = local.width ? box.width / local.width : 0;
  const sy = local.height ? box.height / local.height : 0;
  const rect: SurfaceRect = {
    x: box.x + image.x * sx,
    y: box.y + image.y * sy,
    width: image.width * sx,
    height: image.height * sy,
  };
  let left = Math.max(0, rect.x),
    top = Math.max(0, rect.y);
  let right = Math.min(innerWidth, rect.x + rect.width);
  let bottom = Math.min(innerHeight, rect.y + rect.height);
  let visible =
    video.isConnected &&
    !document.hidden &&
    (!document.fullscreenElement ||
      document.fullscreenElement.contains(video));
  const clips: SurfaceClip[] = [];
  let opacity = 1;
  for (
    let parent: Element | null = video;
    parent;
    parent = parent.parentElement
  ) {
    const current =
      parent === video ? style : getComputedStyle(parent);
    const alpha = parseFloat(current.opacity);
    if (Number.isFinite(alpha)) opacity *= alpha;
    if (
      current.display === "none" ||
      current.visibility === "hidden" ||
      Number(current.opacity) === 0
    )
      visible = false;
    if (
      current.overflowX !== "visible" ||
      current.overflowY !== "visible"
    ) {
      const bounds = clip(parent, current);
      clips.push(bounds);
      left = Math.max(left, bounds.x);
      top = Math.max(top, bounds.y);
      right = Math.min(right, bounds.x + bounds.width);
      bottom = Math.min(bottom, bounds.y + bounds.height);
    }
    // Top-layer content escapes its original tile ancestors.
    if (parent === document.fullscreenElement) break;
  }
  visible &&= right > left && bottom > top;
  // Background removal covers the complete element, including its black bars.
  // A separate fitted-image mask can otherwise leave a light antialiased seam
  // where the page, placeholder and native plane meet at fractional pixels.
  const surface: SurfaceRect = {
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
  };
  return {
    rect,
    surface,
    clips,
    local,
    image,
    visible,
    opacity,
  };
}
export type PresentationGeometry = ReturnType<
  typeof readPresentationGeometry
>;
