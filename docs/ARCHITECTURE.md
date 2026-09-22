# Weblink — Architecture & Directory Guide

Weblink is a SolidJS + TypeScript (strict) WebRTC chat /
file-transfer app. The UI is intentionally kept thin:
components should talk to app state/services via stable
interfaces, while WebRTC/session/transfer details live in
the low-level `domain` layer.

## Top-level layout

- `src/`: Frontend application code (SolidJS).
- `public/`: Static assets served as-is.
- `docker/`: Nginx template + entrypoint scripts used by
  the Docker image.
- `test/`: Vitest unit tests.
- `scripts/`: Repo scripts (clean/build helpers).

## Related signaling repositories

- [`weblink-ws-worker`](https://github.com/99percentpeople/weblink-ws-worker):
  Cloudflare Workers + Durable Objects implementation. This is the
  recommended serverless WebSocket deployment.
- [`weblink-ws-server`](https://github.com/99percentpeople/weblink-ws-server):
  Bun implementation for self-hosting and rollback.
- See [`docs/SIGNALING.md`](SIGNALING.md) for endpoint configuration,
  protocol ownership, deployment validation, and rollback.

## `src/` layout

### UI

- `src/app.tsx`: Application shell (providers, global UI,
  dialogs).
- `src/constants.ts`: Project-wide constants shared across
  UI/application/domain (storage keys, timeouts, prefixes).
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

Most non-trivial logic lives in `src/libs/` and follows an explicit
dependency direction: state/UI → application → domain, while application
may select concrete infrastructure implementations.

- `src/libs/state/`: reactive application state and UI-facing context.
  - `app-state.ts`: shared store shape, including room/client view state.
  - `app-state-context.tsx`: thin composition/API surface consumed by UI.
  - `app-options.ts` and `profile-store.ts`: persisted user configuration.
- `src/libs/application/`: application lifetime and workflow orchestration.
  - `room-service.ts`: owns room join/leave, signaling-client lifetime and
    stale asynchronous join/session rejection. It reserves room/password/client
    identity before client creation, shares concurrent same-identity joins through
    the handshake, and retires old work on identity changes, leave or disposal.
  - `session-service.ts`: owns live `PeerSession` instances and client views.
  - `messaging/`: reactive message history, persistence port and tracked
    message workflows. IndexedDB does not live in this layer.
  - `rtc/`: Weblink's PeerSession transport adapter and protocol composition.
    The reusable P2P protocol itself lives in `domain/protocol/`.
  - `transfer/`: file-transfer workflows, registry and message binding.
  - `cache-service.ts`, `speed-test-service.ts`, `task-service.ts`, etc:
    application-scoped coordinators.
- `src/libs/domain/`: low-level models and P2P behavior. Domain must not
  import `application`, `state` or `infrastructure`.
  - `client.ts`, `ids.ts`, `file.ts`, `message.ts`: shared domain models
    and contracts without application-state ownership.
  - `session.ts`, `peer-negotiation.ts`, `signaling.ts`: WebRTC session and
    signaling contracts.
  - `protocol/`: transport-agnostic P2P control wire contract, runtime
    validation, request/reply state machine and minimal transport/session ports.
    It has no PeerSession, WebRTC, Solid, IndexedDB or AppState dependency.
  - `transfer/`: chunked file sender/receiver and transfer-owned workers.
- `src/libs/infrastructure/`: concrete browser/backend adapters.
  - `signaling/`: WebSocket and Firebase client/transport implementations.
  - `storage/`: IndexedDB chunk cache, transactional assembly, merge worker
    and the IndexedDB message-history repository adapter.
- `src/libs/hooks/`: Solid hooks used by UI.
- `src/libs/utils/`: generic utilities; worker modules live beside their owner
  instead of in a global worker bucket.

## Data flow (high level)

1. UI components call functions from `AppStateContext`
   (`src/libs/state/app-state-context.tsx`).
2. The context delegates workflows to `src/libs/application/*`.
3. Application services create/manage `src/libs/domain/*` primitives and select
   `src/libs/infrastructure/*` adapters where browser/backend implementation is
   required.
4. Application services translate low-level events back into `appState`
   (`src/libs/state/app-state.ts`).

Application orchestration still uses the shared Solid stores; it is not yet a
framework-independent layer. The strict portability boundary currently applies
specifically to `domain/protocol`, not the entire application or WebRTC domain.
Local media stream injection and further route/controller separation remain
incremental follow-up work.

## Signaling and profile privacy

The signaling backend is a rendezvous layer, not an application
message transport:

- Clients publish only `clientId`, `createdAt`, the supported RTC
  profile version, and reconnect metadata. Signaling presence has no
  `name` or `avatar` field.
- The display name and avatar are sent in the versioned
  `client-profile` message after the WebRTC message DataChannel is
  ready. They are sent again when that channel reconnects.
- WebSocket and Firebase clients ignore profile fields from legacy
  presence records and create an anonymous placeholder locally until
  the WebRTC profile arrives.
- SDP offers/answers and ICE candidates must still use signaling
  until a peer connection exists. Room membership and client IDs
  also remain visible to the signaling backend.

## Design conventions

- Keep WebRTC details in `src/libs/domain`. Prefer exposing
  app-level methods from `AppStateContext` over constructing
  protocol/message objects inside UI.
- Keep feature-local constants close to the code. Promote
  constants into `src/constants.ts` only when they are used
  across multiple modules/layers or need consistent tuning.
- Prefer `AbortController` for listener lifetimes; avoid
  leaked intervals/listeners.
- Prefer explicit types at module boundaries (protocols,
  context APIs, service interfaces).
