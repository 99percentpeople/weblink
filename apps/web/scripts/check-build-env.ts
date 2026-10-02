import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "vite";

/** Validate the effective frontend build settings without logging credentials. */
export function checkBuildEnv(
  env: Record<string, string | undefined>,
): { stuns: number; turns: number } {
  try {
    const url = new URL(env.VITE_WEBSOCKET_URL ?? "");
    if (url.protocol !== "ws:" && url.protocol !== "wss:")
      throw new Error();
  } catch {
    throw new Error(
      "Configure a valid VITE_WEBSOCKET_URL in GitHub Environment variables.",
    );
  }

  const stuns = (env.WEBLINK_STUN_SERVERS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (
    !stuns.length ||
    stuns.some((url) => !/^stuns?:\S+$/.test(url))
  ) {
    throw new Error(
      "Configure WEBLINK_STUN_SERVERS in GitHub Environment variables. Rename legacy VITE_STUN_SERVERS; Cloudflare Pages build variables are not passed to GitHub Actions.",
    );
  }

  const turns = (env.VITE_TURN_SERVERS ?? "")
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  for (const entry of turns) {
    const fields = entry.split("|").map((v) => v.trim());
    if (
      fields.length !== 4 ||
      !/^turns?:\S+$/.test(fields[0]) ||
      !["longterm", "hmac"].includes(fields[3])
    ) {
      throw new Error(
        "VITE_TURN_SERVERS accepts url|username|password|longterm or hmac. Cloudflare TURN keys belong on the signaling backend.",
      );
    }
  }
  return { stuns: stuns.length, turns: turns.length };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href ===
    import.meta.url
) {
  const mode = process.argv[2];
  if (!["dev", "production", "desktop"].includes(mode))
    throw new Error(
      "Expected dev, production or desktop mode.",
    );
  const env = loadEnv(
    mode,
    fileURLToPath(new URL("../", import.meta.url)),
    ["VITE_", "WEBLINK_"],
  );
  const counts = checkBuildEnv(env);
  console.log(
    `[build-env] ${mode}: ${counts.stuns} STUN, ${counts.turns} additional TURN; managed TURN comes from the signaling backend.`,
  );
}
