# weblink — Agent Working Agreement

This is the Weblink workspace. The SolidJS + TypeScript (strict) WebRTC app
lives in `apps/web`. Run the commands below from the repository root.

## Workspace and Git boundaries

- `apps/*`, `packages/*` and `servers/*` are Bun workspaces. Run `bun install`
  at the root after initializing submodules; the root `bun.lock` pins all of them.
  Use the isolated linker in `bunfig.toml` to keep frontend and Worker toolchains
  separate. The root Bun override matches `packageManager` so server scripts use
  the same runtime as the workspace.
- `servers/weblink-ws-server` and `servers/weblink-ws-worker` are Git submodules,
  with independent release workflows. Their own lockfiles remain for standalone
  checkouts; workspace installs use the root lockfile. Keep server code portable:
  do not import files from outside their own repositories. After changing server
  dependencies, update the standalone lock in a standalone checkout and refresh
  the root lock after updating the submodule pointer.
- Commit and publish submodule changes in the server repository before updating
  its gitlink in the parent. Normal builds use the pinned commit, not remote HEAD.
- Application version lives in `apps/web/package.json`; root package metadata
  is tooling-only. Build output is `apps/web/dist` and Vite env files belong in
  `apps/web`. Root `.env` configures combined local development; its
  `WEBLINK_WEBSOCKET_URL` override applies only to the Vite dev server.
  Never commit local env files or generated artifacts.
- See `docs/WORKSPACE.md` for commands. `IMPLEMENTATION_PLAN.md`, when present,
  is a local roadmap: keep it untracked and do not include it in commits.

## Quick commands

- Local frontend + Bun signaling: `bun dev` (configure root `.env` first)
- Frontend only: `bun run dev:web`
- Unit tests: `bun run test:unit`
- Integration tests: `bun run test:integration`
- All Vitest correctness tests: `bun run test`
- Type-check: `bun run lint`
- Browser E2E smoke: `bun run test:e2e` or a focused `test:e2e:*` script
- Build: `bun run build`
- Preview: `bun preview`

## Code style / conventions

- TypeScript `strict: true` (see `tsconfig.json`).
- Formatting is handled by Prettier (see `.prettierrc.js`):
  - `printWidth: 60`, `tabWidth: 2`
  - Tailwind class sorting plugins are enabled
- Prefer explicit types at module boundaries (public APIs, protocols).
- Prefer `AbortController` for listener lifetimes; avoid leaked intervals/listeners.

## Architecture notes

Application paths below are relative to `apps/web/`.

- `src/libs/domain`: low-level models, WebRTC controllers and file-transfer primitives.
  Do not import application, state or infrastructure from this layer.
- `src/libs/domain/protocol`: self-contained portable P2P control contract and
  request/reply state machine; keep imports inside this directory.
- `src/libs/application`: room/session, messaging, transfer and task orchestration.
- `src/libs/infrastructure`: signaling backends and IndexedDB implementations.
- `src/libs/state`: reactive stores and the UI-facing composition context.
- UI should talk to services/state via stable interfaces; keep WebRTC details
  inside domain and concrete persistence behind repository/cache contracts.
- See `docs/ARCHITECTURE.md` for the current directory and ownership guide.

## Refactor guidelines (stability-first)

- Make changes incrementally and keep behavior compatible unless explicitly approved.
- Avoid “god modules”: split by responsibility (sender/receiver/protocol/state).
- Add tests for new protocol/state-machine logic (Vitest) and keep existing flows working.
- Prefer dependency injection (pass services in) over adding new global singletons.
- Use the existing shared protocol version; do not add per-message versions for
  compatible additions. Upgrade only for necessary breaking changes that conflict
  with deployed clients, and update all affected endpoints together.

## Testing and visual acceptance

- The user handles visual acceptance manually; UI styles and layouts change frequently.
- Avoid adding or repeatedly running tests tied to screenshots, CSS classes,
  exact dimensions, spacing or layout geometry unless explicitly requested.
- Keep UI tests focused on meaningful behavior: interactions, permissions,
  state transitions, data flow and resource cleanup.
- Run focused checks appropriate to the change. Do not run broad browser or
  visual test suites solely for routine styling and layout adjustments.

## Docs

- Architecture and ownership: `docs/ARCHITECTURE.md`
- Deployment and environment configuration: `docs/DEPLOYMENT.md`
- Test boundaries and commands: `docs/TESTING.md`
- Keep feature docs focused on durable protocol/behavior constraints; do not add
  temporary validation logs or refactor checklists as long-lived documentation.
