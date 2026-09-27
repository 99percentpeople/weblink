# Workspace development

Weblink's original Git repository owns the applications, shared documentation
and root tooling. The two signaling servers are Git submodules. Desktop code is
planned in [IMPLEMENTATION_PLAN.md](../IMPLEMENTATION_PLAN.md); the current
application is `apps/web`.

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

Root workspaces cover `apps/*` and `packages/*`, with one root `bun.lock` and a
hoisted dependency layout. The root package is private tooling; the application
name is `@weblink/web` and its version remains in `apps/web/package.json`.

`servers/*` is intentionally excluded from Bun workspaces. Each server installs
its own dependencies from its own lockfile. No root install or normal build
updates submodule commits or installs their dependencies.

## Frontend commands

Run these from the repository root:

```sh
bun dev
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
Vite reads its env files from `apps/web`; a root `.env.local` is not the frontend
configuration file. Production and dev artifacts are written to `apps/web/dist`.
Root `bun run clean` removes root/frontend dependencies and frontend output; it
does not remove submodule dependencies or any env files.

## Signaling servers

Initialize submodules before running these commands.

Bun server:

```sh
cd servers/weblink-ws-server
bun install --frozen-lockfile
bun run test
bun run build
bun run dev
```

Worker (the independent Worker CI currently uses Bun 1.3.14):

```sh
cd servers/weblink-ws-worker
bun install --frozen-lockfile
bun run typegen
bun run typecheck
bun run format:check
bun run test
bunx wrangler deploy --dry-run
bun run dev
```

Use each server's own env example and deployment instructions. Server secrets
stay in the server environment, not in the frontend. Root `dev:server`,
`dev:worker`, `test:server`, `test:worker` and `build:server` are convenience
wrappers after the server dependencies are installed.

The root `Signaling servers` workflow recursively checks out the pinned commits
and runs independent server checks. It does not publish either server; their
own repositories retain their release workflows. Workflows nested inside a
submodule do not automatically execute as workflows of the parent repository.

## Updating a submodule

A submodule checkout from a fresh clone normally has a detached HEAD. Before
editing, create or switch to a suitable branch in that server repository:

```sh
git -C servers/weblink-ws-server switch -c my-server-change
```

Test and commit there, then push the branch or merge it through that repository's
normal process. Once the selected commit is available from the configured remote,
stage and commit the parent pointer:

```sh
git add servers/weblink-ws-server
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

Build the frontend Docker image from the repository root. Compose uses the
pinned local Bun server submodule as its server build context, so initialize
submodules before running Compose. Standalone frontend builds need only the
root workspace dependencies.
