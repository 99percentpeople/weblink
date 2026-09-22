# weblink — Agent Working Agreement

This repo is a SolidJS + TypeScript (strict) WebRTC chat / file-transfer app.

## Quick commands

- Dev: `bun dev`
- Tests: `bun run test --run` (Vitest, non-watch mode)
- Type-check: `bun run lint`
- Browser checks: `bun run test:protocol`, `bun run test:transfer`,
  `bun run test:cache`, `bun run test:tasks`, `bun run test:speed`
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
- If a protocol/message shape changes, version it and keep backward compatibility where possible.

## Docs

- The refactor roadmap lives at `docs/refactor-plan.md`. Keep it updated as work progresses.
