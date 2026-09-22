# Refactor Plan

Weblink refactors are incremental and behavior-preserving. Each
slice should keep protocol compatibility, move one responsibility
at a time, and add focused tests before the next slice begins.

## Completed slice: local media streams

Goal: separate low-level `MediaStream` operations from app-level
ownership and lifecycle management.

- [x] Move compose/merge/stop helpers to
      `src/libs/domain/media-stream.ts`.
- [x] Add a testable local stream manager in
      `src/libs/application/local-stream-service.ts`.
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

## Completed slice: consent-based peer speed test

Goal: diagnose the current peer connection without sending or caching test files.

- [x] Add a versioned, bounded diagnostic protocol on one temporary DataChannel,
      independent of the single-channel file-transfer implementation.
- [x] Measure each direction from receiver byte counts and monotonic elapsed
      time, with matching receipts rather than enqueue-speed estimates.
- [x] Require remote consent, cap traffic/time, and cancel on stop, teardown or
      connection loss without closing chat/file channels.
- [x] Inject the diagnostic service through the app context and add a localized
      client-info panel with progress, results, traffic notice and failure states.
- [x] Cover protocol/state/UI edge cases and keep a reproducible real-Chromium
      smoke test (`bun run test:speed`); document measurement limits in
      `docs/PEER_SPEED_TEST.md`.

## Completed slice: application task list and tabbed client diagnostics

Goal: separate operation lifetimes from dialogs/routes and make file transfers
and speed tests visible through one task list.

- [x] Keep speed-test ownership in `AppStateProvider`; remove dialog-close,
      target-change and view-unmount cancellation.
- [x] Give each diagnostic a stable run ID and retain recent per-peer results.
- [x] Add a task-service view of existing file/message/cache state plus bounded
      diagnostic history; avoid a duplicate file-transfer state machine.
- [x] Add a global navigation entry with active count, task filters, progress,
      file pause/resume and diagnostic Stop controls.
- [x] Separate client information into Session / Speed test / Raw data tabs.
- [x] Poll statistics only while the information window is visible, with
      non-overlapping requests, stale-result guards and handled errors.
- [x] Cover task history/actions and modal/tab lifetimes with unit/UI tests.
- [x] Exercise the production UI and speed-test service over real loopback
      RTC channels, including close/unmount, reopening results, task-list Stop
      and an unaffected chat channel; check desktop and narrow viewports.

## Completed slice: typed asynchronous P2P control calls

Goal: give control messages a typed asynchronous API with deterministic send,
reply and session lifetimes, without changing file or speed-test data protocols.

- [x] Move wire types, request policy, parsing and immutable snapshots into
      the transport-agnostic `domain/protocol` package.
- [x] Add `call`, `notify`, `handle` and `on`; remove raw request/ACK plumbing
      from application callers and centralize tracked message-state updates.
- [x] Return typed file-list data while retaining the existing storage exchange.
- [x] Resolve transport sends only after actual DataChannel writes; remove
      cancelled/expired queued messages and separate send/reply timeouts.
- [x] Scope requests and deduplication to session instances, check peer identity
      and ACK mode, and cancel pending calls/listeners on session teardown.
- [x] Cover retries, fast replies, duplicate response receipts, reverse resume
      requests, invalid messages, tracked state and session replacement.
- [x] Add real-Chromium protocol coverage (`bun run test:protocol`) and document
      API semantics and limits in `docs/P2P_PROTOCOL.md`.

## Completed slice: session-owned file workflows

Goal: separate file operations from the application provider and distinguish
cache, transfer-run and message identities without changing the wire protocol.

- [x] Introduce an injected `FileTransferService` for file control handlers,
      sending, sharing, downloading, retrying, resuming and pausing.
- [x] Own live runs in `TransferRegistry` by session instance and file ID;
      allow same-cache sends to multiple peers without replacing their runs.
- [x] Reserve cache-writing operations before asynchronous preparation, reject
      unexpected channels and bound channel initialization waits.
- [x] Bind message updates by stable message ID and migrate task/chat/sync
      selectors away from global file-ID-only transfer lookups.
- [x] Cancel preparation on session teardown, close late channels and prevent
      late initialization/finalization from reactivating disposed runs.
- [x] Retain shared caches for preparing, paused and failed deliveries; wait
      for receiver flush/assembly before recording completion.
- [x] Cover service/registry/lifecycle regressions and add a real Chromium,
      IndexedDB and Worker test (`bun run test:transfer`) with byte-exact
      multi-peer sharing and pause/resume verification.
- [x] Document ownership, cancellation and limits in `docs/FILE_TRANSFERS.md`.

## Completed slice: Blob-backed chunk finalization

Goal: move byte-to-Blob conversion into receipt and shorten final assembly while
preserving resumable caches and transaction-safe completion.

- [x] Persist Blob chunk snapshots and read existing ArrayBuffer chunks without
      a schema migration; serialize flushes and restore failed batches.
- [x] Read bounded ordered batches in an isolated merge worker, validate chunk
      coverage and sizes, and atomically write the File and clear chunk records.
- [x] Share concurrent getFile/mergeFile calls, propagate worker failures, cancel
      on cleanup and emit completion only after the final transaction commits.
- [x] Cover real IndexedDB rollback, mixed-format reopening, duplicate receipt,
      concurrent finalization, worker failures and byte-exact transfer/resume.
- [x] Add `test:cache` and `bench:cache`, measure both finalization and total cache
      processing, and record the content-dependent tradeoffs in `docs/CACHE_ASSEMBLY.md`.

## Completed slice: explicit module boundaries and room ownership

Goal: make directory structure reflect ownership, remove type/service buckets and
keep stale room work from reattaching retired sessions.

- [x] Replace the generic `libs/services` bucket with an `application` layer
      grouped only where multiple related modules justify a subdirectory.
- [x] Move WebSocket/Firebase implementations to `infrastructure/signaling`
      and keep domain limited to the signaling/client contracts it actually uses.
- [x] Remove the old `core/services/type.ts`, `core/type.ts` and `core/store.ts`;
      colocate IDs, client models, ICE logic, profile persistence and message
      persistence with their real owners.
- [x] Group file-transfer primitives and compression workers under
      `domain/transfer`.
- [x] Move the IndexedDB cache, transactional chunk assembly and merge worker to
      `infrastructure/storage`, leaving only the file/cache contract in domain.
- [x] Extract `RoomService` from the Solid context and centralize room
      join/leave plus signaling-client listener ownership.
- [x] Reject late `SessionService.addClient` completion after the owning client
      service has changed, and discard signaling clients that resolve after leave.
- [x] Rename the retained low-level `core` directory to `domain` so the code
      matches the intended domain/application/infrastructure architecture.
- [x] Extract browser lifecycle/reconnect coordination into
      `PeerSessionLifecycleController`, media/codec/track ownership into
      `PeerSessionMediaController`, and DataChannel/message queue ownership into
      `PeerSessionChannelController`, leaving `PeerSession` focused on connection
      setup, signaling listen/connect/reconnect and controller orchestration.
- [x] Cover room/session races with focused regression tests and keep typecheck,
      unit tests and production builds green.

## Completed slice: portable control protocol and message persistence boundary

Goal: keep the P2P control contract reusable by future non-Web clients while
removing browser persistence and duplicate timeout ownership from message state.

- [x] Make `domain/protocol` self-contained: no PeerSession, WebRTC,
      application state, IndexedDB, Solid or cross-directory imports.
- [x] Define portable wire DTOs for peers, file metadata, chunk ranges and
      client profiles inside the protocol package.
- [x] Move the generic `P2PProtocol` request/reply/notification state machine
      into `domain/protocol` and parameterize it by a minimal
      `ProtocolSession` + `ProtocolTransport`.
- [x] Keep WebRTC-specific DataChannel queueing outside the portable protocol
      package and adapt PeerSession through `application/rtc/rtc-service.ts`.
- [x] Remove local message `status` from the wire DTO and keep it only in the
      local stored-message model.
- [x] Extract `MessageRepository` from reactive `MessageStores` and move the
      IndexedDB implementation to `infrastructure/storage`.
- [x] Make message-history initialization explicitly await repository loading
      before publishing `message.status = ready`.
- [x] Remove the obsolete message-store send timeout so request lifetime has a
      single owner in the P2P protocol.
- [x] Snapshot reactive store values before asynchronous persistence and wait
      for IndexedDB transaction commit in repository write operations.
- [x] Add portability and repository-boundary regression tests and document the
      cross-client implementation contract in `docs/P2P_PROTOCOL.md`.

## Completed slice: concurrent room join ownership

Goal: prevent pending room creation or a retired handshake from publishing state
for a different room or identity.

- [x] Reserve the room, password and client ID before asynchronous client creation.
- [x] Share the complete factory/handshake operation for concurrent joins with
      the same identity, not just the client factory promise.
- [x] Retire prior work when room credentials or client identity change, and close
      late clients without installing them or mutating the new room.
- [x] Keep old completion/failure handlers from clearing a newer pending join.
- [x] Permit retry after factory/handshake failure and reject joins after disposal.
- [x] Cover both room-creation completion orders, handshake success/failure after
      replacement, identity changes, leave/rejoin, disposal and retries.
- [x] Run strict type checking, all Vitest tests, the production build and real
      Chromium protocol/transfer/cache/task/speed checks, including narrow task UI.

## In progress: signaling backend contract parity

- [x] Add Bun server input validation, socket/client identity checks, binary and
      oversized-message rejection, and a bounded 256-message reconnect cache.
- [x] Exercise those limits with Bun protocol and real WebSocket integration tests.
- [ ] Extend stale-socket ownership checks and focused reconnect race coverage.
- [ ] Share protocol contract fixtures/tests between the Bun server and Worker
      rather than maintaining independent assertions of the same limits.

## Next candidates

1. Finish stale-session handling in the Bun signaling server and share protocol
   contract tests with the Worker; input validation and cache limits already exist.
2. Inject the local stream service through the app context instead of importing
   the singleton directly from UI modules.
3. Break large route components into state/controller and view modules without
   moving WebRTC details into UI code.
4. Revisit the remaining PeerSession connection-establishment code only if it
   still blocks testing or changes; lifecycle, media and channel ownership are
   now separate controllers.
5. Consider extracting `domain/protocol` into its own package once a second
   client implementation exists, keeping the current source directory as the
   canonical contract until then.
