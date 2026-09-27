# Workspace development

Weblink's original Git repository owns the applications, shared documentation
and root tooling. The two signaling servers are Git submodules. The current
application is `apps/web`; desktop integration will reuse its frontend.

## Checkout and dependencies

```sh
git clone --recurse-submodules https://github.com/99percentpeople/weblink.git
cd weblink
bun install --frozen-lockfile
```

For a clone made without submodules, or after pulling a changed gitlink:

```sh
git submodule update --init --recursive
```

Root workspaces cover `apps/*`, `packages/*` and `servers/*`, with one root
`bun.lock` and an isolated dependency layout. A single `bun install` installs the
frontend and both servers after submodules are initialized. The root package is
private tooling; the application name is `@weblink/web` and its version remains
in `apps/web/package.json`.
Isolation keeps the frontend's and Worker's different TypeScript/Vitest versions
from interfering with each other.

Use Bun **1.3.14**, matching `packageManager`, CI and the frontend Docker image.
The combined development command uses Bun's built-in parallel script runner
(introduced in Bun 1.3.9).
The root override also pins the server's npm `bun` dependency to this version,
so its older standalone runtime cannot shadow workspace commands.

Git submodules still pin server source revisions and retain independent release
workflows. Workspace installs use root `bun.lock`; the servers' own lockfiles
remain unchanged for standalone clones. Dependency changes need both the
standalone lockfile and, after updating the gitlink, a refreshed root lockfile.
Installing dependencies does not update submodule commits.

## Frontend and local signaling together

After the root install and submodule initialization:

```sh
cp .env.example .env
bun dev
```

`bun dev` loads root `.env` explicitly. It contains the Vite port
(`WEBLINK_WEB_PORT`), server port/address (`PORT`, `HOSTNAME`) and local signaling
URL (`WEBLINK_WEBSOCKET_URL`). The URL in the example expands `${PORT}`, so it
follows server port changes. Existing server-specific settings and secrets
remain in the server's own env files; root values take precedence when running
`bun dev`.

`bun dev` runs Vite and the Bun server with labeled output. Defaults are
localhost:5173 and 127.0.0.1:9000. Ctrl+C stops both; a script exiting with an
error stops the other. Vite fails on an occupied port instead of changing it.
Stop existing services or select different ports in `.env` before starting.

Use `bun run dev:web` or `bun run dev:server` to start just one service. The
root `WEBLINK_WEBSOCKET_URL` overrides the frontend endpoint only while serving
Vite; production builds continue to use the app's `VITE_*` settings.

## Frontend commands

Run these from the repository root:

```sh
bun run dev:web
bun run lint
bun run test:unit
bun run test:integration
bun run build
bun run build:dev
bun preview
```

All existing `test:e2e:*` and `bench:browser:cache` commands remain available at
the root. They delegate to the web workspace, preserving application-relative
resource and test paths. Direct application commands also work:

```sh
bun run --cwd apps/web dev
```

Copy `apps/web/.env.example` to `apps/web/.env.local` for local configuration.
Vite reads application env files from `apps/web`; root `.env` holds the combined
development settings described above. Keep frontend build-time `VITE_*` values
in the application env files. Production and dev artifacts are written to `apps/web/dist`.
Root `bun run clean` removes workspace dependencies, including the server
dependencies, and frontend output. It does not remove env files.

## Signaling servers

Initialize submodules and run `bun install` once at the root before these commands.

Bun server:

```sh
cd servers/weblink-ws-server
bun run test
bun run build
bun run dev
```

Worker:

```sh
cd servers/weblink-ws-worker
bun run typegen
bun run typecheck
bun run format:check
bun run test
bunx wrangler deploy --dry-run
bun run dev
```

For a standalone server clone, run `bun install --frozen-lockfile` in that clone
to use its own lockfile. Use each server's env example and deployment instructions.
Server secrets stay in the server environment, not in the frontend. Root `dev:server`,
`dev:worker`, `test:server`, `test:worker` and `build:server` are convenience
wrappers after the workspace dependencies are installed.

The root `Signaling servers` workflow recursively checks out the pinned commits
and installs from the root lockfile before running server checks. It does not
publish either server; their own repositories retain their release workflows.
Workflows nested inside a
submodule do not automatically execute as workflows of the parent repository.

## Updating a submodule

A submodule checkout from a fresh clone normally has a detached HEAD. Before
editing, create or switch to a suitable branch in that server repository:

```sh
git -C servers/weblink-ws-server switch -c my-server-change
```

Test and commit there, then push the branch or merge it through that repository's
normal process. Once the selected commit is available from the configured remote,
refresh the workspace lockfile and commit it with the parent pointer:

```sh
bun install
git add servers/weblink-ws-server bun.lock
git commit -m "chore: update Bun signaling server"
```

The Worker follows the same workflow under `servers/weblink-ws-worker`.
`git submodule update --init --recursive` restores the parent-pinned version;
`--remote` selects new upstream commits and is an intentional dependency update,
not a normal installation step. Inspect local server changes before switching
the pinned version.

## Building and releasing

See [DEPLOYMENT.md](DEPLOYMENT.md). Root CI reads release metadata from
`apps/web/package.json` and root `CHANGELOG.md`, writes frontend env files into
`apps/web`, and deploys `apps/web/dist`. Web release tags and channels retain
their existing meaning.

Initialize submodules before building the frontend Docker image or running
Compose. The frontend image reads all workspace manifests and installs only the
root tooling and frontend dependencies. Compose uses the pinned local Bun
server submodule as its server build context, with that server's standalone lock.
