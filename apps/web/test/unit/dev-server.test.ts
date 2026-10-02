// @vitest-environment node
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, type ViteDevServer } from "vite";
import solid from "vite-plugin-solid";
import { describe, expect, it, vi } from "vitest";

async function fixture() {
  const directory = await mkdtemp(
    join(tmpdir(), "weblink-dev-server-"),
  );
  const root = join(directory, "web");
  const lockfile = join(directory, "bun.lock");
  const servers: ViteDevServer[] = [];
  await mkdir(join(root, "node_modules/test-dep"), {
    recursive: true,
  });
  await writeFile(lockfile, "lock-v1");
  await writeFile(
    join(root, "package.json"),
    '{"name":"dev-fixture","type":"module"}',
  );
  await writeFile(
    join(root, "node_modules/test-dep/package.json"),
    '{"name":"test-dep","main":"index.js"}',
  );
  await writeFile(
    join(root, "node_modules/test-dep/index.js"),
    "export const value = 1;",
  );
  await writeFile(
    join(root, "index.html"),
    '<script type="module" src="/bootstrap.ts"></script>',
  );
  // Both a native composition owner and its UI consume the same identity.
  // Only the UI is a Solid refresh boundary.
  await writeFile(
    join(root, "bootstrap.ts"),
    'import { context } from "./context"; import { View } from "./view"; console.log(context, View);',
  );
  await writeFile(
    join(root, "context.ts"),
    'export const context = Symbol("scope");',
  );
  await writeFile(
    join(root, "view.tsx"),
    'import { context } from "./context"; export function View() { return <div>{String(context)}</div>; }',
  );
  return {
    root,
    lockfile,
    async server(mode = "development") {
      const server = await createServer({
        root,
        configFile: false,
        mode,
        logLevel: "silent",
        cacheDir: `node_modules/.vite/${mode}`,
        plugins: [solid()],
        resolve: {
          alias: {
            "solid-js": fileURLToPath(
              new URL(
                "../../node_modules/solid-js",
                import.meta.url,
              ),
            ),
          },
        },
        optimizeDeps: {
          noDiscovery: true,
          include: ["test-dep"],
        },
        server: { host: "127.0.0.1", port: 0 },
      });
      servers.push(server);
      await server.listen();
      return server;
    },
    async metadata(server: ViteDevServer) {
      let metadata!: { lockfileHash: string };
      await vi.waitFor(async () => {
        metadata = JSON.parse(
          await readFile(
            join(
              server.config.cacheDir,
              "deps/_metadata.json",
            ),
            "utf8",
          ),
        );
      });
      return metadata;
    },
    async dispose() {
      await Promise.all(
        servers.map((server) => server.close()),
      );
      await rm(directory, { recursive: true, force: true });
    },
  };
}

describe("native development boundaries", () => {
  it("separates simultaneous platform caches and natively detects the workspace text Bun lockfile on startup", async () => {
    const project = await fixture();
    try {
      const web = await project.server();
      const desktop = await project.server("desktop");
      expect(web.config.cacheDir).not.toBe(
        desktop.config.cacheDir,
      );
      const previous = await project.metadata(web);
      expect(
        (await project.metadata(desktop)).lockfileHash,
      ).toBe(previous.lockfileHash);
      await web.close();
      await writeFile(project.lockfile, "lock-v2");
      const restarted = await project.server();
      expect(restarted.config.cacheDir).toBe(
        web.config.cacheDir,
      );
      await vi.waitFor(async () => {
        expect(
          (await project.metadata(restarted)).lockfileHash,
        ).not.toBe(previous.lockfileHash);
      });
    } finally {
      await project.dispose();
    }
  });

  it("keeps view edits on Solid HMR and propagates context edits to the plain bootstrap", async () => {
    const project = await fixture();
    try {
      const server = await project.server();
      await server.transformRequest("/bootstrap.ts");
      await server.transformRequest("/view.tsx");
      await server.transformRequest("/context.ts");
      const send = vi.spyOn(server.ws, "send");
      await writeFile(
        join(project.root, "view.tsx"),
        'import { context } from "./context"; export function View() { return <div>updated {String(context)}</div>; }',
      );
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ type: "update" }),
        ),
      );
      expect(send).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "full-reload" }),
      );
      send.mockClear();
      await writeFile(
        join(project.root, "context.ts"),
        'export const context = Symbol("updated scope");',
      );
      await vi.waitFor(() =>
        expect(send).toHaveBeenCalledWith(
          expect.objectContaining({ type: "full-reload" }),
        ),
      );
    } finally {
      await project.dispose();
    }
  });
});
