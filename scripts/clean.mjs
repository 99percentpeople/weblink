import { rm } from "node:fs/promises";

const root = new URL("../", import.meta.url);
for (const path of [
  "node_modules/",
  "apps/web/node_modules/",
  "apps/web/dist/",
  "apps/web/dev-dist/",
  "apps/desktop/node_modules/",
  "apps/desktop/dist/",
  "packages/platform/node_modules/",
  "servers/weblink-ws-server/node_modules/",
  "servers/weblink-ws-worker/node_modules/",
]) {
  await rm(new URL(path, root), {
    recursive: true,
    force: true,
  });
  console.log(`Removed ${path}`);
}
