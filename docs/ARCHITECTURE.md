# Weblink — Architecture & Directory Guide

Weblink is a SolidJS + TypeScript (strict) WebRTC chat /
file-transfer app. The UI is intentionally kept thin:
components should talk to app state/services via stable
interfaces, while WebRTC/session/transfer details live in
the low-level `core` layer.

## Top-level layout

- `src/`: Frontend application code (SolidJS).
- `public/`: Static assets served as-is.
- `docker/`: Nginx template + entrypoint scripts used by
  the Docker image.
- `test/`: Vitest unit tests.
- `scripts/`: Repo scripts (clean/build helpers).
- `weblink-ws-server/`: Optional Bun WebSocket signaling
  server (separate project).

## `src/` layout

### UI

- `src/app.tsx`: Application shell (providers, global UI,
  dialogs).
- `src/constants.ts`: Project-wide constants shared across
  UI/services/core (storage keys, timeouts, prefixes).
- `src/routes/`: Route-level pages (Solid Router).
  - `src/routes/client/[id]/...`: Main client session pages
    (chat/sync, etc).
- `src/components/`: Reusable UI building blocks.
  - `components/app/`: app-scoped components (nav,
    wakelock, etc).
  - `components/dialogs/`: unified dialog directory.
    - Modal primitives: `base.tsx`, `dialog.tsx`,
      `drawer.tsx`.
    - Business dialogs: room/join, QR code share, preview,
      forward, delete confirms, about, media selection,
      compatibility details, media-constraints dialogs,
      etc.
    - `ModalProvider` is mounted once in `src/app.tsx` and
      dialog factories auto-register themselves globally.
      Consumers call `open()` directly and do not render
      dialog components in page JSX.
    - Route pages should import dialog creators from this
      directory instead of defining separate dialog files
      under route folders.
  - `components/ui/`: shared UI primitives (buttons, inputs,
    popovers, etc).

### Application logic

Most non-trivial logic lives in `src/libs/`:

- `src/libs/state/`: App state store and context provider.
  - `app-state.ts`: Shared store shape + setters.
    - Includes media constraint state
      (`media.constraints.*`) used by video dialogs/pages.
  - `app-state-context.tsx`: The main UI-facing API surface
    (functions that UI calls).
- `src/libs/services/`: App-level orchestration.
  - `session-service.ts`: Creates/destroys `PeerSession`s,
    tracks client view data, wires event listeners.
  - `rtc-protocol.ts`: Higher-level protocol over data
    channels (request/response style).
  - `rtc-service.ts`, `transfer-service.ts`, etc: service
    helpers that bridge UI state ↔ core primitives.
  - `local-stream-service.ts`: Owns the active local media
    stream, replaces/stops streams, and tracks dynamic or
    ended media tracks.
- `src/libs/core/`: Low-level primitives.
  - `media-stream.ts`: Pure helpers for composing, merging,
    and stopping browser `MediaStream`s.
  - `session.ts`: `PeerSession` (RTCPeerConnection lifecycle,
    negotiation/reconnect, channels).
  - `message.ts`: Message shapes + message store (chat + file
    transfer message state).
  - `file-sender.ts`, `file-receiver.ts`, `file-transfer-*`:
    Chunked transfer implementation.
  - `core/services/`: Signaling client implementations
    (e.g. Firebase/WebSocket).
- `src/libs/cache/`: IndexedDB/chunk cache utilities.
- `src/libs/hooks/`: Solid hooks used by UI.
- `src/libs/workers/`: Web Workers (e.g. compression).
- `src/libs/utils/`: Generic utilities.

## Data flow (high level)

1. UI components call functions from `AppStateContext`
   (`src/libs/state/app-state-context.tsx`).
2. Those functions delegate to app services
   (`src/libs/services/*`) and update `appState`
   (`src/libs/state/app-state.ts`).
3. Services create/manage core primitives (`src/libs/core/*`),
   attach listeners, and translate low-level events into
   app-level state updates.

## Design conventions

- Keep WebRTC details in `src/libs/core`. Prefer exposing
  app-level methods from `AppStateContext` over constructing
  protocol/message objects inside UI.
- Keep feature-local constants close to the code. Promote
  constants into `src/constants.ts` only when they are used
  across multiple modules/layers or need consistent tuning.
- Prefer `AbortController` for listener lifetimes; avoid
  leaked intervals/listeners.
- Prefer explicit types at module boundaries (protocols,
  context APIs, service interfaces).
