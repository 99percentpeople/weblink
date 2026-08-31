# Refactor Plan

Weblink refactors are incremental and behavior-preserving. Each
slice should keep protocol compatibility, move one responsibility
at a time, and add focused tests before the next slice begins.

## Completed slice: local media streams

Goal: separate low-level `MediaStream` operations from app-level
ownership and lifecycle management.

- [x] Move compose/merge/stop helpers to
      `src/libs/core/media-stream.ts`.
- [x] Add a testable local stream manager in
      `src/libs/services/local-stream-service.ts`.
- [x] Replace the dual-signal reactive bridge with explicit
      `replace`, `clear`, and `dispose` operations.
- [x] Handle tracks added after activation and remove ended tracks.
- [x] Migrate app, dialog, and video route callers to the new API.
- [x] Add focused utility and lifecycle tests.
- [x] Run formatting, unit tests, strict type checking, and the
      production build.

## Completed slice: session lifecycle hardening

Goal: make connection failures and session teardown deterministic
before splitting the large `PeerSession` implementation.

- [x] Remove closed sessions by their remote client key through an
      idempotent detach path.
- [x] Release `makingOffer` after failed renegotiation.
- [x] Await asynchronous signaling setup during reconnect.
- [x] Replace the async `Promise` executor in `connect` with explicit
      offer, channel, connection, timeout, and cleanup flows.
- [x] Add dependency injection for ICE server loading in service
      tests.
- [x] Add focused success and failure regression tests.
- [x] Move project-wide type checking out of `lint-staged` so file
      arguments are not passed to `tsc -p`.
- [x] Run both test runners, strict type checking, formatting, and
      the production build.

## Completed slice: mobile dialog scrolling

Goal: keep dialog navigation and actions visible while long content
scrolls within the available mobile viewport.

- [x] Constrain dialog height with the dynamic viewport unit.
- [x] Add a dedicated body container with vertical scrolling and
      overscroll containment.
- [x] Keep the title, description, footer, and close button outside
      the scroll container.
- [x] Remove legacy per-dialog scrolling classes that could create
      nested scroll regions.
- [x] Add class-level and rendered-layout regression tests.
- [x] Run both test runners, strict type checking, formatting, and
      the production build.

## Completed slice: peer profiles over WebRTC

Goal: keep personal display metadata off the signaling backend while
retaining room rendezvous and connection signaling.

- [x] Add a versioned `client-profile` RTC protocol message.
- [x] Publish only client/connection metadata and the capability
      version through WebSocket/Firebase presence.
- [x] Send and refresh real names/avatars when the message
      DataChannel becomes ready.
- [x] Update live client views and persisted message contacts from
      received RTC profiles.
- [x] Ignore profile fields from legacy signaling records and create
      anonymous placeholders locally until RTC profiles arrive.
- [x] Make both WebSocket backends discard profile fields before
      storing or forwarding presence.
- [x] Run both test runners, strict type checking, formatting, and
      both production builds.

## Completed slice: fixed signaling endpoint

Goal: keep all WebSocket clients on the deployment-configured
signaling backend so persisted user settings cannot diverge.

- [x] Remove the WebSocket URL from app options and the settings UI.
- [x] Resolve the signaling URL only from deployment configuration.
- [x] Leave legacy custom URL fields inert in persisted options.
- [x] Add regression tests and run both test runners, strict type
      checking, formatting, and the production build.

## Completed slice: Durable Object signaling

Goal: provide a serverless WebSocket signaling deployment without
changing the frontend protocol or mixing profile data into signaling.

- [x] Implement each room as a Cloudflare Durable Object.
- [x] Use hibernatable WebSockets, reconnect retention, alarms, and
      durable message caching.
- [x] Preserve the Bun server's room and signaling protocol while
      rejecting profile fields at the service boundary.
- [x] Deploy and validate `wss://ws.webl.ink` without changing the
      current frontend deployment or removing the Bun rollback path.
- [x] Document development, deployment, validation, and rollback in
      [`docs/SIGNALING.md`](SIGNALING.md).

## Next candidates

1. Inject the local stream service through the app context instead
   of importing the singleton directly from UI modules.
2. Split `PeerSession` connection, media sender, and reconnect
   responsibilities while retaining its existing public API.
3. Break large route components into state/controller and view
   modules without moving WebRTC details into UI code.
4. Increase tests around media device acquisition failures and
   partial camera/microphone/program-audio success.
