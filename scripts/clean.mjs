import { rm } from "node:fs/promises";

const root = new URL("../", import.meta.url);
for (const path of [
  "node_modules/",
  "apps/web/node_modules/",
  "apps/web/dist/",
  "apps/web/dev-dist/",
]) {
  await rm(new URL(path, root), {
    recursive: true,
    force: true,
  });
  console.log(`Removed ${path}`);
}
