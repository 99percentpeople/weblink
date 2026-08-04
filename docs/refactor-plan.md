# Refactor Plan

Weblink refactors are incremental and behavior-preserving. Each
slice should keep protocol compatibility, move one responsibility
at a time, and add focused tests before the next slice begins.

## Current slice: local media streams

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

## Next candidates

1. Inject the local stream service through the app context instead
   of importing the singleton directly from UI modules.
2. Split `PeerSession` connection, media sender, and reconnect
   responsibilities while retaining its existing public API.
3. Break large route components into state/controller and view
   modules without moving WebRTC details into UI code.
4. Increase tests around media device acquisition failures and
   partial camera/microphone/program-audio success.
