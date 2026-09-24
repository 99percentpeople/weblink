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

## Portable file-transfer wire contract

The current file-data protocol is intentionally separated from the reusable
control protocol. A non-Web client does not need IndexedDB, `FileSender`,
`FileReceiver` or Web Workers, but it must implement the following channel and
byte contract exactly.

Canonical definitions live in:

- `domain/transfer/protocol.ts`: JSON control frames and validation.
- `domain/transfer/packet.ts`: binary block header codec.
- `domain/protocol/messages.ts`: the higher-level `send-file`,
  `request-file` and `resume-file` setup messages.

### Channel identity

The file payload channel uses:

- DataChannel protocol: `transfer`
- label: `<fileId>-0`

The protocol string is currently **unversioned legacy wire format**. An
incompatible future transfer format must use a new protocol identifier rather
than silently changing the meaning of `transfer`.

### JSON control frames

The active transfer channel exchanges these JSON frames:

```json
{ "type": "request-content", "ranges": [0, [2, 5], 9] }
{ "type": "complete" }
{ "type": "pause" }
```

A range item is either one non-negative chunk index or an inclusive
`[start, end]` pair.

`request-head` and `head` remain accepted by the protocol parser for legacy
compatibility, although the current application workflow already exchanges file
metadata through the higher-level control protocol and does not actively use
those frames.

### Binary block packet

File bytes are sent as binary packets with a fixed **7-byte header**:

| Byte range | Encoding           | Meaning                                         |
| ---------- | ------------------ | ----------------------------------------------- |
| 0..3       | uint32, big-endian | chunk index                                     |
| 4..5       | uint16, big-endian | block index inside the compressed chunk         |
| 6          | uint8              | `0` or `1`; last block of this compressed chunk |
| 7..        | bytes              | compressed block payload                        |

The sender first compresses each logical chunk with the raw DEFLATE format used
by `fflate.deflateSync`, then splits that compressed byte sequence into blocks.
The receiver collects blocks by `chunkIndex` / `blockIndex`, concatenates
through the block marked `isLastBlock`, and inflates the complete compressed
chunk with raw DEFLATE semantics before writing the original chunk bytes.

Compression level is a local sender choice and is not encoded on the wire. Level
0 is still a valid DEFLATE stream. Therefore another client must decode raw
DEFLATE regardless of which compression level produced it.

The current block index is uint16, so one compressed chunk can contain at most
65,536 addressable block positions. The current Web sender's default block size
is much larger than required for normal configured chunk sizes, but alternative
clients must preserve the uint16 bound.

### Cross-client implementation rules

A compatible non-Web sender/receiver should:

1. Complete the higher-level `send-file` / `request-file` control exchange
   before attaching payload semantics to the transfer channel.
2. Use the exact `transfer` protocol name and `<fileId>-0` label for this
   legacy format.
3. Treat chunk ranges as inclusive and preserve logical chunk indexes when
   resuming.
4. Encode packet integers big-endian with the 7-byte header above.
5. Raw-DEFLATE each complete logical chunk before splitting it into blocks.
6. Reassemble every compressed chunk before inflating it.
7. Treat `complete` as transfer-channel completion signaling, not as durable
   cache/file finalization on the receiving client.
8. Treat `pause` as intentional channel teardown with resumable cached chunks.
9. Reject malformed JSON control frames and invalid binary headers rather than
   interpreting them as payload data.

Unit coverage in `test/unit/file-transfer-protocol.test.ts` locks the JSON shapes,
range validation and exact byte-level header encoding.

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

## Local sharing and directory tasks

Sharing belongs to a local content record, so identical bytes and all chat
references project the same `isShared` value. Imports, newly received bytes and
pre-upgrade caches default to private; duplicate imports or receives preserve
existing local state. Remote metadata never controls this flag.

A new private, room, forwarded or library-selected send enables sharing after
file preparation and local message creation, before network delivery. Retry and
resume preserve the current flag, and later network failure does not undo a new
send's sharing choice. An independent retained reference keeps shared bytes alive
through message deletion and automatic attachment cleanup. Unsharing retains
local bytes; explicit deletion removes every reference and the directory item.
The shared list is local and persists across rooms.

The local shared-file header can add existing library files or import local files
and folders. These explicit additions enable sharing only after a successful
import; folder selection uses the application's existing ZIP packaging flow.
Normal library imports remain private. Directory rows observe the same download
tasks as the task list, including progress, pause/resume, cancellation and completion, so
returning to a member's list restores the current transfer state.
Refreshes keep the current rows and selection visible until the replacement page
arrives; downloads from stale rows are disabled until permission is revalidated.
Cancellation is terminal and removes that receive's partial cache and file reference.
Pause retains partial data for resume. Cancelling one recipient keeps a source
needed by another authorized recipient alive, then releases the cancelled reference
once the remaining recipients finish or detach. Other local references remain intact.
Getting a cancelled file again creates a new task. Completed local content is matched
by fingerprint, including different remote IDs or names: rows show it as acquired,
bulk selection skips it, and service calls create no additional task or reference.
Deleting the local content makes it retrievable again.

Directory fetches use `shared-files-v1` and the version-3 catalog described in
[P2P_PROTOCOL.md](P2P_PROTOCOL.md). Their task lifecycle is independent of message
bindings, while sharing the existing transfer registry, verification, range resume
and content receive coordinator. Existing verified local content needs no remote
request; a new or resumed transfer always checks current remote permission. Closing or switching the sidebar cancels directory requests
without cancelling already started transfers. Directory tasks are kept for the
application session; local completed files persist in IndexedDB.

## Testing

File-transfer unit/integration coverage and the real-Chromium transfer smoke
path are documented in [TESTING.md](TESTING.md). The browser smoke test uses
real RTCDataChannels, IndexedDB and compression workers, but remains a local
loopback correctness check rather than a cross-device throughput benchmark.
