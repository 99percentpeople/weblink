import type {
  PresentationGeometry,
  SurfaceClip,
  SurfaceRect,
} from "./presentation-geometry";

const namespace = "http://www.w3.org/2000/svg";
function svg<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
) {
  const element = document.createElementNS(namespace, tag);
  for (const [key, value] of Object.entries(attributes))
    element.setAttribute(key, value);
  return element;
}
function rectangle({ x, y, width, height }: SurfaceRect) {
  return `M${x},${y}h${width}v${height}h${-width}Z`;
}
function roundedPath(rect: SurfaceClip) {
  const {
    x,
    y,
    width: w,
    height: h,
    corners: [tl, tr, br, bl],
  } = rect;
  const arc = (
    corner: readonly [number, number],
    endX: number,
    endY: number,
  ) =>
    corner[0] > 0 && corner[1] > 0
      ? `A${corner[0]},${corner[1]} 0 0 1 ${endX},${endY}`
      : `L${endX},${endY}`;
  return `M${x + tl[0]},${y}H${x + w - tr[0]}${arc(tr, x + w, y + tr[1])}V${y + h - br[1]}${arc(br, x + w - br[0], y + h)}H${x + bl[0]}${arc(bl, x, y + h - bl[1])}V${y + tl[1]}${arc(tl, x + tl[0], y)}Z`;
}
function placeholderMask(
  width: number,
  height: number,
  rect: SurfaceRect,
) {
  const content = `<svg xmlns="${namespace}" width="${width}" height="${height}"><path fill="white" fill-rule="evenodd" d="${rectangle({ x: 0, y: 0, width, height })}${rectangle(rect)}"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(content)}")`;
}
interface Hole {
  group: SVGGElement;
  path: SVGPathElement;
  clips: SVGPathElement[];
  geometry: string;
  placeholder: string;
  opacity: number;
}
/** Keep DOM controls intact. Reuse a live SVG mask instead of loading a new SVG
 * image each animation frame. Only background layers expose the HWND below. */
export function createPresentationLayout() {
  const holes = new Map<symbol, Hole>();
  let base: HTMLDivElement | undefined;
  let root: SVGSVGElement | undefined;
  let mask: SVGMaskElement | undefined;
  let background: SVGRectElement | undefined;
  let viewport = "";
  const ensureMask = () => {
    if (!root) {
      const id = `native-video-${crypto.randomUUID()}`;
      root = svg("svg", {
        width: "0",
        height: "0",
        "aria-hidden": "true",
      });
      root.style.position = "fixed";
      root.style.pointerEvents = "none";
      const defs = svg("defs");
      mask = svg("mask", {
        id,
        maskUnits: "userSpaceOnUse",
        maskContentUnits: "userSpaceOnUse",
        x: "0",
        y: "0",
        "mask-type": "luminance",
      });
      background = svg("rect", { fill: "white" });
      mask.append(background);
      defs.append(mask);
      root.append(defs);
      base = document.createElement("div");
      base.className = "native-video-background";
      document.body.prepend(root, base);
      document.documentElement.style.setProperty(
        "--native-video-mask",
        `url("#${id}")`,
      );
      document.documentElement.classList.add(
        "native-video-active",
      );
    }
    const next = `${innerWidth},${innerHeight}`;
    if (viewport !== next) {
      viewport = next;
      for (const element of [mask!, background!]) {
        element.setAttribute("width", String(innerWidth));
        element.setAttribute("height", String(innerHeight));
      }
    }
  };
  return {
    show(
      key: symbol,
      video: HTMLVideoElement,
      geometry: PresentationGeometry,
    ) {
      ensureMask();
      let hole = holes.get(key);
      const { rect, clips, local, image } = geometry;
      if (!hole) {
        hole = {
          group: svg("g"),
          path: svg("path", { fill: "black" }),
          clips: [],
          geometry: "",
          placeholder: "",
          opacity: -1,
        };
        holes.set(key, hole);
        mask!.append(hole.group);
        video.dataset.nativeVideo = "true";
      }
      if (
        hole.clips.length !== clips.length ||
        !hole.path.parentNode
      ) {
        hole.group.replaceChildren();
        hole.clips = [];
        let parent = hole.group;
        for (const _ of clips) {
          const id = `native-clip-${crypto.randomUUID()}`;
          const clip = svg("clipPath", {
            id,
            clipPathUnits: "userSpaceOnUse",
          });
          const path = svg("path");
          clip.append(path);
          hole.group.append(clip);
          const group = svg("g", {
            "clip-path": `url(#${id})`,
          });
          parent.append(group);
          parent = group;
          hole.clips.push(path);
        }
        parent.append(hole.path);
        hole.geometry = "";
      }
      const signature = JSON.stringify([rect, clips]);
      if (signature !== hole.geometry) {
        hole.geometry = signature;
        hole.path.setAttribute("d", rectangle(rect));
        clips.forEach((bounds, index) =>
          hole.clips[index]!.setAttribute(
            "d",
            roundedPath(bounds),
          ),
        );
      }
      if (hole.opacity !== geometry.opacity) {
        hole.opacity = geometry.opacity;
        // Fade the opening along with the DOM tile; the native plane itself
        // sits outside that tile's CSS opacity/exit animation.
        hole.path.setAttribute(
          "opacity",
          String(geometry.opacity),
        );
      }
      const placeholder = JSON.stringify([local, image]);
      if (placeholder !== hole.placeholder) {
        hole.placeholder = placeholder;
        // This mask is in untransformed element coordinates. Its parent already
        // supplies the actual border/overflow rounding, including black bars.
        video.style.maskImage = placeholderMask(
          local.width,
          local.height,
          image,
        );
      }
    },
    hide(key: symbol, video: HTMLVideoElement) {
      const hole = holes.get(key);
      if (!hole) return;
      hole.group.remove();
      holes.delete(key);
      delete video.dataset.nativeVideo;
      video.style.removeProperty("mask-image");
      if (holes.size) return;
      base?.remove();
      root?.remove();
      base = undefined;
      root = undefined;
      mask = undefined;
      background = undefined;
      viewport = "";
      document.documentElement.classList.remove(
        "native-video-active",
      );
      document.documentElement.style.removeProperty(
        "--native-video-mask",
      );
    },
  };
}
