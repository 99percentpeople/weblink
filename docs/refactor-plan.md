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

## Completed slice: WebSocket reconnect lifecycle

Goal: keep signaling recovery alive through realistic network outages
and make socket ownership deterministic.

- [x] Replace fixed three-attempt reconnects with capped exponential
      backoff and equal jitter.
- [x] Pause retries while offline and retry immediately when the
      browser reports connectivity.
- [x] Make connect and reconnect operations single-flight and bind
      every socket to a connection generation.
- [x] Close timed-out and superseded sockets and ignore late
      handshake events.
- [x] Cancel pending connection attempts and delayed retries when
      the user leaves the room.
- [x] Rebind peer signaling listeners in the same event turn as a
      resumed room join.
- [x] Make signaling socket replacement and teardown idempotent and
      contain malformed-message failures.
- [x] Add focused timeout, retry, cancellation, offline, and sender
      rebinding tests.
- [x] Run frontend and backend tests, strict type checking,
      formatting, and all production builds.

## Completed slice: acknowledged room resume

Goal: remove the ambiguity between an open WebSocket and an installed
room session before replaying reconnect traffic.

- [x] Add a versioned `joined` acknowledgment with an explicit
      `resumed` result to both WebSocket backends.
- [x] Emit the acknowledgment only after membership is installed and
      before presence or cached signaling is replayed.
- [x] Keep the existing `connected` password challenge compatible
      with older clients and retain a timed fallback for older
      self-hosted servers.
- [x] Buffer presence and peer signaling until the room handshake is
      acknowledged.
- [x] Route incoming WebSocket signaling through the owning client
      service instead of attaching one message listener per peer.
- [x] Preserve ordered peer signals that arrive before sender and
      session listeners are ready.
- [x] Add frontend handshake/replay/fallback tests and backend
      protocol/order assertions.

## Completed slice: suspend recovery and negotiation generations

Goal: rebuild mobile sessions after page suspension without allowing
signals from retired peer connections to contaminate the replacement.

- [x] Track page suspension separately from ordinary network
      disconnection and defer reconnect work while frozen.
- [x] Restart recovery when lifecycle resume events find a previously
      connectable session without a peer connection.
- [x] Prevent an aborted reconnect loop from clearing or disconnecting
      a newer reconnect owner.
- [x] Assign every `RTCPeerConnection` a random generation and include
      it in offer, answer, and ICE payloads.
- [x] Adopt the accepted offer generation, queue early candidates by
      generation, and retire replaced or ignored generations.
- [x] Serialize signal processing and stop asynchronous work from
      continuing against a replaced peer connection.
- [x] Continue accepting generation-less payloads from older clients.
- [x] Add focused freeze/resume, outgoing generation, stale answer,
      candidate replay, and legacy compatibility tests.

## Completed slice: negotiation controller extraction

Goal: reduce `PeerSession` ownership without changing its public API or
moving WebRTC behavior into UI code.

- [x] Move perfect-negotiation state, SDP/ICE handling, generation
      retirement, and candidate queues into `PeerNegotiationController`.
- [x] Keep offer creation cancellation-safe when a peer connection is
      replaced during an asynchronous browser operation.
- [x] Bind the serialized signal queue to a connection epoch so queued
      legacy signals cannot cross a peer-connection replacement.
- [x] Keep the existing `handleOffer` export available from
      `session.ts` for compatibility.
- [x] Add direct controller tests alongside the `PeerSession`
      integration coverage.

## Next candidates

1. Continue splitting `PeerSession` by extracting reconnect/lifecycle
   coordination and media sender management behind its existing API.
2. Harden stale-session handling and cache limits in the Bun
   signaling server, then share protocol contract tests with the
   Worker.
3. Inject the local stream service through the app context instead
   of importing the singleton directly from UI modules.
4. Break large route components into state/controller and view
   modules without moving WebRTC details into UI code.
