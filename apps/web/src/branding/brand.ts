import { APP_NAME } from "../constants";

/** The only editable source for Weblink's icon and wordmark. */
export const BRAND = {
  name: APP_NAME,
  paths: [
    "M136 170 178 316Q185 340 202 319L296 170",
    "M224 170 269 316Q276 340 293 319L388 170",
  ],
  strokeWidth: 46,
  crossingWidth: 70,
  circleRadius: 224,
  colors: {
    backgroundStart: "#132A46",
    backgroundEnd: "#0A1627",
    foreground: "#F7FBFF",
    accentStart: "#8DF1E5",
    accentEnd: "#2CCAD8",
    markAccent: "#0996A3",
    textLight: "#171717",
    textDark: "#FAFAFA",
  },
  wordmark: {
    fontFamily:
      "'Inter Variable', Inter, 'Avenir Next', 'Segoe UI', sans-serif",
    fontSize: 64,
    fontWeight: 700,
    letterSpacing: -2.2,
  },
} as const;

export type BrandVariant =
  | "icon"
  | "logo"
  | "mark"
  | "inverse"
  | "monochrome"
  | "pwa";

export interface BrandArtwork {
  viewBox: string;
  width: number;
  height: number;
  markup: string;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&apos;",
    };
    return entities[character];
  });
}

/** A unique prefix is required when several inline logos share a page. */
export function getBrandArtwork(
  variant: BrandVariant,
  prefix: string,
): BrandArtwork {
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(prefix)) {
    throw new Error("Invalid SVG ID prefix");
  }
  const { colors, paths, wordmark } = BRAND;
  const hasBackground =
    variant === "icon" || variant === "pwa";
  const inverse = variant === "inverse";
  const foreground =
    hasBackground || inverse
      ? colors.foreground
      : "currentColor";
  const accent =
    variant === "monochrome"
      ? "currentColor"
      : hasBackground || inverse || variant === "logo"
        ? `url(#${prefix}-accent)`
        : colors.markAccent;

  const definitions = `<defs>
    <linearGradient id="${prefix}-bg" x1="96" y1="64" x2="416" y2="448" gradientUnits="userSpaceOnUse">
      <stop stop-color="${colors.backgroundStart}"/>
      <stop offset="1" stop-color="${colors.backgroundEnd}"/>
    </linearGradient>
    <linearGradient id="${prefix}-accent" x1="214" y1="165" x2="388" y2="334" gradientUnits="userSpaceOnUse">
      <stop stop-color="${colors.accentStart}"/>
      <stop offset="1" stop-color="${colors.accentEnd}"/>
    </linearGradient>
    <mask id="${prefix}-cross" x="0" y="0" width="512" height="512" maskUnits="userSpaceOnUse" style="mask-type:luminance">
      <rect width="512" height="512" fill="white"/>
      <path d="${paths[1]}" fill="none" stroke="black" stroke-width="${BRAND.crossingWidth}" stroke-linecap="round" stroke-linejoin="round"/>
    </mask>
  </defs>`;
  const symbol = `<g transform="translate(-6 8)" fill="none" stroke-width="${BRAND.strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
    <path d="${paths[0]}" stroke="${foreground}" mask="url(#${prefix}-cross)"/>
    <path d="${paths[1]}" stroke="${accent}"/>
  </g>`;

  if (variant === "logo") {
    return {
      viewBox: "0 0 452 144",
      width: 452,
      height: 144,
      markup: `${definitions}
  <g transform="translate(-30 -38) scale(.44)">${symbol}</g>
  <text x="184" y="95" fill="currentColor" font-family="${escapeXml(wordmark.fontFamily)}" font-size="${wordmark.fontSize}" font-weight="${wordmark.fontWeight}" letter-spacing="${wordmark.letterSpacing}">${escapeXml(BRAND.name)}</text>`,
    };
  }

  if (hasBackground) {
    return {
      viewBox: "0 0 512 512",
      width: 512,
      height: 512,
      markup: `${definitions}${variant === "pwa" ? `\n  <rect width="512" height="512" fill="${colors.backgroundEnd}"/>` : ""}
  <circle cx="256" cy="256" r="${BRAND.circleRadius}" fill="url(#${prefix}-bg)"/>
  ${symbol}`,
    };
  }

  return {
    viewBox: "80 124 352 264",
    width: 352,
    height: 264,
    markup: `${definitions}\n  ${symbol}`,
  };
}

export function renderBrandSvg(
  variant: BrandVariant,
  prefix = `wl-${variant}`,
  color?: string,
): string {
  const artwork = getBrandArtwork(variant, prefix);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${artwork.width}" height="${artwork.height}" viewBox="${artwork.viewBox}" fill="none" role="img" aria-labelledby="${prefix}-title"${color ? ` color="${escapeXml(color)}"` : ""}>
  <title id="${prefix}-title">${escapeXml(BRAND.name)}</title>
  ${artwork.markup}
</svg>\n`;
}

/** Stable public filenames; all are generated, never maintained by hand. */
export const BRAND_FILES = {
  icon: "/branding/weblink-app-icon.svg",
  logo: "/branding/weblink-logo.svg",
  logoLight: "/branding/weblink-logo-light.svg",
  logoDark: "/branding/weblink-logo-dark.svg",
  mark: "/branding/weblink-mark.svg",
  inverse: "/branding/weblink-mark-inverse.svg",
  monochrome: "/branding/weblink-monochrome.svg",
  pwaSource: "/branding/weblink-pwa.svg",
  faviconAlias: "/branding/weblink-favicon.svg",
  favicon: "/favicon.svg",
  ico: "/favicon.ico",
  pwa64: "/pwa-64x64.png",
  pwa192: "/pwa-192x192.png",
  pwa512: "/pwa-512x512.png",
  maskable: "/maskable-icon-512x512.png",
  apple: "/apple-touch-icon-180x180.png",
} as const;

// Content-based URLs make changed icons visible to browser/PWA caches.
// This is a cache identifier, not a cryptographic/security hash.
function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(
      hash ^ value.charCodeAt(index),
      16777619,
    );
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export const BRAND_REVISION = fingerprint(
  JSON.stringify(BRAND) +
    (
      [
        "icon",
        "logo",
        "mark",
        "inverse",
        "monochrome",
        "pwa",
      ] as const
    )
      .map((variant) => renderBrandSvg(variant))
      .join(""),
);

export function brandAssetUrl(path: string): string {
  return `${path}?v=${BRAND_REVISION}`;
}

export const BRAND_ASSETS = Object.fromEntries(
  Object.entries(BRAND_FILES).map(([key, path]) => [
    key,
    brandAssetUrl(path),
  ]),
) as { readonly [Key in keyof typeof BRAND_FILES]: string };

export const BRAND_MANIFEST_ICONS = [
  {
    src: BRAND_ASSETS.pwa64,
    sizes: "64x64",
    type: "image/png",
  },
  {
    src: BRAND_ASSETS.pwa192,
    sizes: "192x192",
    type: "image/png",
  },
  {
    src: BRAND_ASSETS.pwa512,
    sizes: "512x512",
    type: "image/png",
  },
  {
    src: BRAND_ASSETS.icon,
    sizes: "any",
    type: "image/svg+xml",
    purpose: "any",
  },
  {
    src: BRAND_ASSETS.maskable,
    sizes: "512x512",
    type: "image/png",
    purpose: "maskable",
  },
];
