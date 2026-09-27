# Contributing

Pull requests should target the `public` branch and keep existing protocol and
user-facing behavior compatible unless a breaking change has been discussed.

## Workspace setup

```sh
git clone --recurse-submodules https://github.com/99percentpeople/weblink.git
cd weblink
bun install --frozen-lockfile
```

The frontend lives in `apps/web`. Root scripts run in that application directory.
The server submodules keep their own dependencies and locks; see
[workspace development](docs/WORKSPACE.md) for their setup and update workflow.

## Required checks

The `CI / Checks` job uses Bun 1.3.8 and runs the frontend type-check, unit tests
and integration tests. Tagged releases additionally validate the version in
`apps/web/package.json` against the tag and root `CHANGELOG.md`.

```sh
bun run lint
bun run test:unit
bun run test:integration
bun run build
```

The separate `Signaling servers` workflow checks the pinned Bun server and
Cloudflare Worker. Run the relevant checks when updating a submodule; the Worker
uses its own Bun version and toolchain. Do not add deployment credentials to pull
request workflows. CI must remain usable for contributions from forks.

## Code changes

- Keep TypeScript strict and format changed files with the root Prettier config.
- Add focused tests for new behavior and protocol/state-machine changes.
- Keep WebRTC primitives in `apps/web/src/libs/domain`, orchestration in
  `apps/web/src/libs/application`, and concrete adapters in infrastructure.
- Reuse the shared protocol version for compatible additions. Breaking wire
  changes require coordinated endpoint updates.
- Commit server changes in their own repository before updating the parent
  gitlink. Do not include unpublished submodule commits in a pull request.
