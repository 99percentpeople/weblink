# File transfer workflows and ownership

File transfers use the typed RTC control protocol described in
[P2P_PROTOCOL.md](P2P_PROTOCOL.md), but retain their own binary data channels,
compression workers and cache lifecycle. UI components do not construct file
control messages or create transfer channels.

## Responsibilities

- `FileTransferService` owns send, share, request, retry, resume and pause
  workflows. Its dependencies are injected; it has no UI or toast imports.
  It registers the three incoming file request handlers and the RTC channel /
  session-close observers, and is disposed with the application provider.
- `TransferRegistry` owns live runs, their channels, initialization, timers,
  cache leases and teardown. Runs are indexed internally by actual session
  instance and logical file ID, not by a global file ID alone.
- `transfer-message-binding.ts` connects a run to its explicit message ID.
  Each event resolves that ID again, so deleting an earlier message cannot
  redirect progress into another array element. Receiver completion waits
  for cache flush and final file assembly.
- `file-transfer-state.ts` defines the published run snapshot and selectors
  used by chat, synchronization and task views. The task list no longer
  guesses ownership from the newest message with the same file ID.
- `transfer-service.ts` supplies application-specific factories and adapters.
  `FileSender`, `FileReceiver`, packet encoding and compression remain core
  implementation details.

The provider retains presentation policy (including error toasts) and its
existing public UI methods. It delegates file work to the service.

## Identity and concurrency

A cached file, a transfer run and a chat message have different identities.

Each active run has an independent ID, its owning `PeerSession`, `fileId`,
`messageId` and transferer. Two peers may read/send the same completed cache
simultaneously without replacing each other's run or progress. A second
operation for the same session/file is rejected instead of destroying the
first. Cache-writing preparation is reserved before asynchronous cache
creation, and a cache cannot have concurrent receivers or be rewritten while
an active sender is reading it.

Incoming channels are accepted only for an expected incoming-channel run on
that session. Unknown, duplicate and retired-session channels are closed;
there is no global unbounded pending-channel buffer. One early channel can
wait on its known run until cache/worker initialization finishes. A run that
never becomes ready has a bounded channel wait.

Wire control messages, chunk packets and the existing `<fileId>-0` channel
labels are unchanged. This does not enable parallel runs for the same file
on the same session. The label does not carry a run generation, so it cannot
by itself identify two different historical attempts within that exact
session/file pair; introducing that distinction would require a separate
wire-protocol change.

## Cancellation and finalization

`sendFile`, `shareFile` and `requestFile` resolve after their control exchange
and transfer setup, not after the entire file finishes transferring. Observe
message/task state for final completion. Cancelling a pending file request
leaves a resumable paused state rather than a failed send. Cancellation does
not retract bytes already transmitted or discard already cached chunks.

Session close and application leave cancel in-flight preparations and destroy
owned runs. A late result is checked against the operation and run owner
before it can attach a channel or continue a workflow. An unabortable late
`createChannel()` result is closed. Sender/receiver initialization checks its
closed state after asynchronous work, avoiding post-close worker attachment.

Registry teardown removes ownership before invoking close callbacks, so
reentrant or delayed events cannot remove a replacement run. Subscriptions
and timers belong to the run. UI unmount does not stop application-owned
transfers.

Final receiving completion means cache flush and file assembly have finished,
not just that the last data frame arrived. Late assembly results cannot mark
a retired run's message complete. Flush and assembly failures are recorded
on the associated file message.

A shared cache is retained by both active runs and preparing operations.
Automatic deletion waits until leases are released and registered deliveries
have completed. Paused or failed deliveries retain the cache regardless of
which peer completes first; a successful retry/resume of the same delivery
releases that requirement. Explicit user cache deletion remains distinct
from automatic deletion and stops affected active runs.

## Validation

Run the regular suite and type checks:

```sh
bunx vitest run
bun run lint
```

Focused tests cover the registry, service and workflow lifetimes, including
same-file multi-peer sends, writer exclusion, early / wrong-session / late
channels, session replacement, message deletion, paused-cache retention,
flush failure and finalization.

A real browser smoke test exercises the full service / registry / protocol
path with real RTCDataChannels, IndexedDB and compression/decompression
workers:

```sh
bun run test:transfer
```

It shares one 1 MiB + 17 byte file with two receivers, verifies both SHA-256
hashes, pauses an 8 MiB + 31 byte transfer after partial reception, resumes
from cached ranges and verifies the final hash. It also checks that the
control/chat channel remains open. Logical peers use isolated physical
IndexedDB names in the disposable browser profile, so they do not share
receiver data accidentally or touch the user's application caches.

This is a loopback correctness test, not a cross-device throughput benchmark.
