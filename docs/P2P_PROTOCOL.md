# Weblink P2P control protocol

The control protocol is intentionally independent from Weblink's Solid UI,
IndexedDB stores, signaling backend and browser `PeerSession` implementation.

There are three distinct concerns:

1. **Signaling** discovers room peers and exchanges SDP/ICE until a peer
   connection exists.
2. **P2P control protocol** exchanges typed JSON requests, replies and
   notifications over any reliable ordered message transport.
3. **Data protocols** such as file payload transfer and speed testing use their
   own channels/state machines and are not encoded as control messages.

A future desktop, mobile or native client should implement the wire contract in
`src/libs/domain/protocol/` and provide its own transport/session adapter. It
does not need Weblink's `PeerSession`, Solid state, IndexedDB or UI services.

## Portable client boundary

The TypeScript reference implementation exposes a minimal transport-agnostic
contract:

```ts
type ProtocolSession = {
  clientId: string;
  targetClientId: string;
};

interface ProtocolTransport<S extends ProtocolSession> {
  send(
    session: S,
    message: SessionMessage,
    options?: MessageSendOptions,
  ): Promise<void>;

  onAny(
    handler: (context: {
      session: S;
      message: SessionMessage;
    }) => void | Promise<void>,
  ): () => void;

  onSessionClosed(
    handler: (session: S) => void,
  ): () => void;
}
```

`send()` must resolve only after the underlying transport has accepted the
serialized message for sending. It must not resolve merely because a message was
placed in a local queue.

The generic protocol state machine can then run on any client-specific session
object:

```ts
const protocol = new P2PProtocol(myTransport);

const session = {
  clientId: "device-a",
  targetClientId: "device-b",
  nativeHandle: 42,
};

await protocol.call(session, "send-text", {
  data: "hello",
});
```

The browser implementation adapts `PeerSession` through
`application/rtc/rtc-service.ts`. The WebRTC DataChannel send queue lives next
to the session adapter in `domain/session-send-queue.ts`; it is deliberately
not part of the portable protocol package.

## Wire envelope

Every control message is JSON and has the same base envelope:

```json
{
  "id": "message-id",
  "type": "send-text",
  "createdAt": 1760000000000,
  "client": "sender-client-id",
  "target": "receiver-client-id"
}
```

Required base fields:

| Field       | Type   | Meaning                                            |
| ----------- | ------ | -------------------------------------------------- |
| `id`        | string | Stable request/message identity. Retries reuse it. |
| `type`      | string | Message discriminator.                             |
| `createdAt` | number | Millisecond timestamp created by the sender.       |
| `client`    | string | Sender client ID.                                  |
| `target`    | string | Intended receiver client ID.                       |

Local UI state such as `sending`, `received`, progress or persistence status
is **not** part of the wire protocol. Those fields belong to each client's local
message model.

The envelope rejects the reserved local fields `conversationId`, `room`,
`deliveries`, `roomTransfers`, `localSequence` and `lastReadSequence`. Local arrival order and read
cursors belong to the receiving browser. A private `send-text` cannot attach these fields to
bypass room capability and binding validation during history projection.

The canonical TypeScript wire DTOs and request policy are in
`domain/protocol/messages.ts`. Runtime validation is in
`domain/protocol/validation.ts`.

## Request types and ACK policy

The request policy is defined once by `requestSpec`:

| Request               | Reply behavior                      |
| --------------------- | ----------------------------------- |
| `send-text`           | `ack` mode `receive`                |
| `room-capabilities`   | `ack` mode `receive`                |
| `send-room-text`      | `ack` mode `receive`                |
| `send-room-file`      | `ack` mode `receive`                |
| `request-room-file`   | `ack` mode `send`                   |
| `send-clipboard`      | `ack` mode `receive`                |
| `send-file`           | `ack` mode `receive`                |
| `request-file`        | `ack` mode `send`                   |
| `request-shared-file` | `ack` mode `send`                   |
| `resume-file`         | `ack` mode `receive`                |
| `request-storage`     | `storage` response plus receipt ACK |

An ACK means the receiving request handler completed successfully. It does
**not** mean durable database storage, file-transfer completion, clipboard
permission or that a human read a message.

The browser room-chat handler additionally waits for its local IndexedDB write
before returning. Its receipt therefore confirms successful local persistence
at that instant; it does not imply a read receipt, server history, or retention
after the user deletes browser data.

Typical use:

```ts
const receipt = await protocol.call(session, "send-text", {
  data: "Hello",
});

const page = await protocol.call(
  session,
  "request-storage",
  {
    pageIndex: 0,
    pageSize: 25,
    search: "report",
    sort: [{ field: "fileName", desc: false }],
  },
);

const stopHandling = protocol.handle(
  "request-storage",
  async ({ session, message, signal }) => {
    // Apply local authorization/policy here.
    return {
      items: [],
      totalCount: 0,
      pageIndex: 0,
      pageSize: message.pageSize,
      sharingEnabled: false,
    };
  },
);
```

`request-storage` returns a `StoragePage`, not a metadata array. It never exposes a
browser `File`, IndexedDB record or cache implementation.

### Online room text chat (version 1)

`room-capabilities` and `send-room-text` require
`P2P_ROOM_CHAT_PROTOCOL_VERSION` (currently 1). They use the existing point-to-point
control DataChannel: `client` and `target` remain the actual session's peer IDs.
The signaling protocol, presence records, and private `send-text` contract do not
change. Never turn an unsupported room message into a private message.

After the message channel becomes ready, both peers send `room-capabilities`
with `{ roomId, token }`. Each token is fresh for that local room/channel binding.
The peer acknowledges only an offer belonging to its active room and actual
session. A client is supported after receiving the peer's token and the ACK to
its own offer. A later incoming offer can restart a failed initial negotiation;
this permits different room-initialization timing. A missing/unsupported version
or a peer that cannot complete negotiation is not a supported room-chat peer.
The browser waits for both parts even when an unordered channel delivers the ACK
before the reciprocal offer. Negotiation waits are bounded and cancelled when
the room/channel binding ends.

`send-room-text` carries:

```ts
{
  roomId: string;
  senderToken: string;
  recipientToken: string;
  senderName: string;
  senderAvatar: string | null;
  data: string;
}
```

Room IDs are nonempty and at most 256 UTF-16 code units; binding tokens are at
most 128. Names are at most 128, avatars at most 256 Ki, and nonblank text at most
64 Ki UTF-16 code units. Receivers validate both binding tokens, the active room,
and the session identity before writing history. Session replacement, room
changes and channel closure retire the old binding. Names and avatars are
sender-provided display snapshots, not independent identity authentication.
The browser sends `senderAvatar: null` on room text requests; peer avatars already
use the separate profile exchange. It may retain its own avatar in local history,
but does not repeat a potentially large base64 image in every text frame. The
character bounds do not override a transport's negotiated maximum message size;
a transport rejection remains a visible failed delivery for that recipient.

The browser sender stores one logical message and snapshots the peers whose
channels are ready at send time. The same message ID, sender and creation time
identify each recipient's copy. Each recipient has its own
`sending` / `delivered` / `failed` / `unsupported` state; one ACK cannot complete
the whole group. Fan-out runs with bounded concurrency so one failed peer does
not stop all other recipients. Manual retries target only original failed peers
that are currently connected to the same room. A replacement session uses its
new binding tokens while retaining the logical message ID, time and content.

There is no offline outbox, late-join history transfer, server message archive,
or automatic replay to newly joined members. History and organization labels
belong to the local browser. Conversation IDs include the signaling namespace
and room ID locally; the namespace is not sent as an authentication claim.
The application store persistently deduplicates matching logical room messages
and rejects conflicting IDs. This supplements the protocol's bounded,
session-local request cache; it does not provide globally ordered history or
cross-device exactly-once delivery.

### Room file offers and explicit downloads (version 1)

Room text and capability envelopes remain version 1. A capability offer may add
`features: ["room-file-v1"]`; at most 16 nonempty feature strings of at most 64
UTF-16 code units are allowed. Unknown features are ignored. A peer without the
file feature can still exchange room text. An ACK alone never proves file
support: the peer's own capability offer must advertise the feature. Unsupported
room offers are never automatically converted into private file messages.
Explicit local forwarding creates a new private copy with a fresh file ID;
the original room attachment keeps its room-only scope.

`send-room-file` uses `P2P_ROOM_FILE_PROTOCOL_VERSION` (currently 1). Its payload
contains `roomId`, `senderToken`, `recipientToken`, `senderName`, `senderAvatar`,
`fid`, `fileName`, `fileSize`, `chunkSize`, and optional `mimeType` / `lastModified`.
Only these fields and the standard envelope are accepted; no file bytes belong
in the offer. Filenames contain 1–1024 UTF-16 code units, MIME types at most 255,
file size is a nonnegative safe integer, and chunk size is a positive safe
integer. Room/token/profile bounds match room text. The recipient durably stores
the offer before ACKing it. That ACK means metadata was received, not downloaded.
The receiver may opt in locally to request newly received small files up to a
per-room size limit (default 5 MiB, auto-download off). This uses the same
`request-room-file` flow as a manual download, without changing the protocol or
replaying offers from history. Duplicate receipts and paused or failed transfers
do not automatically start another request.

An explicit download uses `request-room-file` version 1 with the room and current
binding tokens, `offerId`, `fid`, `resume`, and optional chunk `ranges`. It does
not repeat file metadata: the authorized original offer and provider cache are
authoritative. Structural range validation happens at the protocol boundary;
the application must check range bounds against the authorized file's actual
chunk count. The offer ID and request envelope ID must differ. Each new or resumed
download attempt uses a fresh request ID; transport retries repeat the same
request. Reusing a completed request's ID/time can replay its cached ACK without
starting another transfer. The `send` ACK acknowledges download setup, not binary
completion.

Both sides validate the current room/session and binding tokens. The provider
also validates the stored offer's sender, room namespace, file identity and
original recipient snapshot. Room-only attachments must not bypass this check
through legacy `request-file` / `resume-file` entry points. Reconnection requires
fresh binding tokens and a new download request; a saved offer does not guarantee
that its provider is online or its file remains available.

Room files and text share local history and per-recipient offer delivery states.
Sender-side per-peer transfer status/progress lives separately in local
`roomTransfers`, which is rejected on the wire. Receipt and transfer writes are
serialized per logical message. Duplicate file offer IDs must retain the same
sender, scope, timestamp, file identity and metadata. A reload marks interrupted
delivery attempts failed and active per-peer transfers paused; an offer that has
never been downloaded does not become a paused transfer merely by being loaded.

### Shared directory contract (version 3)

`request-storage` and `storage` require `version: 3` (the message factory supplies
it). Peers announce `shared-files-v1` in their profile features before browsing or
fetching. Earlier directory versions and full-cache responses are rejected;
unsupported peers are reported without falling back to cache enumeration.
The binary data protocol and signaling remain unchanged.

Query payload:

```ts
type StorageQuery = {
  pageIndex: number; // zero-based non-negative safe integer
  pageSize: number; // integer in [1, 100]
  search?: string; // at most 256 UTF-16 code units
  sort?: {
    field:
      | "fileName"
      | "fileSize"
      | "createdAt"
      | "lastModified"
      | "mimetype";
    desc: boolean;
  }[];
};
```

Providers filter the **entire visible directory** before sorting and slicing.
Search is a filename substring after NFKC normalization, trimming and lowercasing
on both sides of the comparison. Sorting uses the requested field order; absent
sorting defaults to filename ascending. Text sort keys use the same normalization;
numeric fields use numeric comparison. Missing optional values sort as zero/empty
string. File ID ascending is the final deterministic tie-breaker, using code-unit
comparison rather than locale collation. Duplicate/unknown sort fields are rejected.

The `storage.data` response is:

```ts
type StoragePage = {
  items: ProtocolFileMetadata[];
  totalCount: number; // matches after search, before slicing
  pageIndex: number; // actual page, clamped to the last valid page
  pageSize: number;
  sharingEnabled: boolean;
};
```

An empty or denied directory has zero items/count and page index zero. A denied
response has `sharingEnabled: false` and reveals no underlying count. A request
re-checks per-peer `provideFileList` every time. This flag also authorizes directory
fetches; disabling it stops that member's active directory uploads. Explicit chat
attachment grants remain independent.

Only complete, verified content with a locally enabled sharing flag enters the
index, once per content identity. IDs refer to independent shared references,
never original private or room attachment IDs. Each item includes its BLAKE3
fingerprint. Explicit DTO projection excludes `file`, `chunkCount`, `isComplete`,
`isShared`, and `isMerging`.
The browser index is updated by committed cache events; page queries do not flush
or scan every IndexedDB file database. Query-time CPU still filters/sorts the
in-memory metadata index; this is not a persistent database pagination index.

### Shared file downloads

`request-shared-file` version 1 carries `fid` (shared reference), `fingerprint`,
`chunkSize`, `transferId` (a fresh `shared-transfer_` UUID for local receive
storage), optional inclusive `ranges`, and `have`. A `have: true` request checks
current authorization without opening a binary channel, allowing verified local
content to be reused. Otherwise the provider creates a read-only transfer alias,
validates the request against its shared content, and acknowledges setup. Binary
channels use `<transferId>-0`. New attempts and resumes use fresh control request
IDs; a resumed task keeps its transfer ID and cached chunks.

Both enumeration and fetching require a current connected member session and
permission. Fetching also validates the shared reference, fingerprint and chunk
size. Unsharing or deleting content terminates its directory uploads. Unknown
IDs, room attachment IDs and private reference IDs cannot be used as shared IDs.
Legacy `request-file` requires a matching outgoing private message to that peer;
`resume-file` requires a matching incoming private message. Neither can fetch an
arbitrary cache. Shared fetches create tasks and local library references on the
receiver, never chat messages on either peer.

### Directory invalidation

`storage-changed` is an envelope-only notification. It carries **no payload**:
no file IDs, metadata, deltas, counts, revisions or sharing state. Receivers
invalidate their active query and request its current page again with the same
page size, search and sort. Do not send unsolicited `storage` responses.

The provider coalesces visible directory changes over 100 ms, and does not publish
chunk progress. It notifies only ready peers permitted to list files. A sharing
policy change also sends one empty invalidation, including when access is disabled;
subsequent hidden directory changes do not notify that peer.

`FileCatalogService` owns provider/notification lifetime. `RemoteFileCatalog`
coordinates one active page: concurrent invalidations coalesce, changes during a
request force a follow-up query, superseded query responses are discarded, and
query changes/disposal cancel pending work. Requests retain the standard protocol
send/reply deadlines. Failures leave an explicit stale/error state; user refresh,
a later notification, or reconnect can retry. Notifications themselves have no
receipt or durable delivery guarantee.

A browser directory view fetches pages only while the current route is exactly
`/client/:id/sync` for its peer (a trailing slash is allowed), the peer is online,
and its message channel is ready. Leaving that route or losing the connection
removes the view's subscription and cancels pending work, even if the component
remains mounted. Notifications elsewhere do not trigger directory queries.
Reopening the view or recovering the connection always requests a fresh page.
Disconnected peers show an empty state instead of a stale table; the header's
client-settings entry remains available. Refresh is beside the table's View control.
TanStack Table controls pagination,
search and sorting with `manualPagination`, `manualFiltering`, `manualSorting` and
remote `rowCount`; it does not re-slice or re-sort each returned page. Search input
is debounced 250 ms, and search/sort/page-size changes reset to page zero. Provider
clamping is applied to controlled pagination without issuing a duplicate query.
Local download state remains a display column, not a remote query filter.

## Notifications

Notifications do not wait for a remote ACK:

- `client-profile`
- `stream-state`
- `read-text`
- `storage-changed` (envelope-only directory invalidation)

```ts
await protocol.notify(session, "client-profile", {
  profile: {
    name: "Alice",
    avatar: null,
  },
});

await protocol.notify(session, "stream-state", {
  mode: "media",
  videoSources: [
    { mid: "0", kind: "camera" },
    { mid: "2", kind: "screen" },
  ],
});
```

`stream-state` carries a complete video-source snapshot. `videoSources` maps the
negotiated RTP `mid` of each published video transceiver to `camera` or `screen`.
The receiver independently records `RTCTrackEvent.transceiver.mid` for each
local received track and joins the two views by MID; `MediaStreamTrack.id` is not
used as a wire identity. This keeps the participant/avatar (and microphone
ownership) separate from shared-screen tiles without depending on track labels
or event ordering. Video and audio tracks themselves still travel over negotiated
RTP transceivers. A participant may publish several video tracks at once; receivers
aggregate tracks from all signaled streams, including streamless tracks.
Removing one source renegotiates only the changed senders. Local capture tracks
are borrowed by each peer connection and are stopped only by the application's
capture owner, so closing a peer or a screen does not stop the remaining
publications.

The `client-profile` notification carries
`P2P_PROFILE_PROTOCOL_VERSION` (currently 1). The historical
`RTC_PROFILE_PROTOCOL_VERSION` name remains an alias. Profile versioning belongs to
the wire protocol; profile normalization and UI placeholders remain local client
policy.

## File-control DTOs

File control messages carry metadata only. The actual bytes use the separate
file-transfer protocol.

`send-file` and `request-file` use:

- `fid`: logical file ID
- `fileName`
- `fileSize`
- optional `mimeType`
- optional `lastModified`
- `chunkSize`

`request-file` additionally carries:

- `resume`
- optional chunk ranges, where each item is either one numeric index or an
  inclusive `[start, end]` pair

`storage.data.items` uses portable metadata with `mimetype`. Browser-only fields such as `File`, cache handles and
transfer progress are never part of the control protocol.

## Timeouts, cancellation and retries

| Option          |   Default | Meaning                                          |
| --------------- | --------: | ------------------------------------------------ |
| `sendTimeoutMs` | 10,000 ms | Maximum wait for the transport to accept a send. |
| `timeoutMs`     |  5,000 ms | Reply deadline after send succeeds.              |
| `retries`       |         0 | Additional attempts after reply timeout.         |
| `retryDelayMs`  |    250 ms | Delay before another attempt.                    |
| `signal`        |      none | Cancels send waiting, reply waiting and retries. |

The application message store does **not** own a second send timeout. Request
lifetime is owned only by the P2P protocol.

An expired or cancelled unsent request must not be sent later when the transport
recovers. After a message has already been sent, cancellation cannot undo the
remote operation.

Retries preserve the exact same frozen payload, ID and timestamp.

## Deduplication and session lifetime

Requests are scoped to the actual local session handle, not globally to an ID.

Successful request results are retained in a bounded in-memory dedup cache:

- TTL: `PROTOCOL_DEDUP_TTL_MS` (10 minutes)
- maximum retained entries: `PROTOCOL_DEDUP_MAX_ENTRIES` (512)

A duplicate completed request replays the cached reply rather than rerunning the
handler. A duplicate received while the first handler is still running does not
run a second handler.

This is not persistent exactly-once delivery. Reloads, new sessions, dedup
expiry and process restarts can all allow the operation to run again.

Closing a session immediately rejects its pending calls, aborts handler
lifetimes and retires that session handle. A reply belonging to a retired
session cannot settle a replacement session.

## Errors

Portable code should use `P2PProtocolError` and
`P2PProtocolErrorCode`. Weblink still exports the historical
`RtcProtocolError` aliases for compatibility.

Codes:

- `already-pending`
- `timeout`
- `send-timeout`
- `aborted`
- `closed`
- `remote-error`
- `send-failed`
- `invalid-message`

Invalid timeout/retry configuration raises `RangeError`.

## Validation and trust boundary

All incoming network control data must pass
`validateSessionMessage()`/`parseSessionMessage()` before handlers run.

Validation checks:

- envelope IDs and timestamp
- sender/target identity against the owning session
- message-specific payloads
- numeric file metadata
- chunk ranges
- client-profile shape/version
- storage metadata

The protocol implementation snapshots outgoing request data before retries so
callers cannot mutate the payload after the first attempt.

## Weblink application integration

The portable state machine has no concept of chat history or IndexedDB.

Weblink adds those concerns above the protocol:

- `application/messaging/peer-messaging-service.ts` maps tracked protocol
  requests to local message-history state.
- `application/messaging/room-messaging-service.ts` owns room capability
  negotiation, binding lifetime, recipient snapshots and per-peer receipts.
- `application/messaging/message-store.ts` owns reactive chat/file history.
- `application/messaging/message-repository.ts` is the persistence port.
- `infrastructure/storage/indexeddb-message-repository.ts` is the browser
  persistence adapter.
- `application/rtc/rtc-service.ts` adapts browser `PeerSession` events to
  `ProtocolTransport<PeerSession>`.
- `application/rtc/rtc-protocol.ts` is only the Weblink composition/factory
  wrapper around the portable `P2PProtocol`.

## Module ownership

Portable protocol package:

- `domain/protocol/index.ts`: public export surface.
- `domain/protocol/messages.ts`: complete wire DTOs and request/ACK policy.
- `domain/protocol/validation.ts`: network validation and immutable snapshots.
- `domain/protocol/errors.ts`: portable errors and call options.
- `domain/protocol/transport.ts`: minimal session/transport ports.
- `domain/protocol/request-manager.ts`: pending calls, reply matching, dedup and teardown.
- `domain/protocol/protocol.ts`: generic `P2PProtocol` facade.
- `domain/protocol/constants.ts`: protocol-owned bounds.

WebRTC adapter:

- `domain/session-send-queue.ts`: browser DataChannel queue; not portable protocol.
- `application/rtc/rtc-service.ts`: PeerSession transport adapter.
- `application/rtc/rtc-protocol.ts`: Weblink singleton composition.

## Cross-client implementation checklist

A non-Web client should:

1. Use the same JSON field names and message discriminators.
2. Validate `client` and `target` against the owning peer session.
3. Preserve request `id`, `createdAt` and payload across retries.
4. Implement the ACK modes exactly as `requestSpec` defines them.
5. Treat `request-storage` as a typed response flow, not a generic ACK.
6. Deduplicate completed requests within a bounded session-local cache.
7. Abort pending calls when its peer session closes/replaces.
8. Keep file bytes and speed-test traffic outside the control message stream.
9. Keep local message/UI/persistence fields out of the wire envelope.
10. Treat signaling as a separate rendezvous protocol.

## Testing

Protocol unit/integration coverage and the real-Chromium DataChannel smoke test
are documented in [TESTING.md](TESTING.md). Keep portable contract behavior in
unit/integration tests; use the browser E2E smoke only for behavior that depends
on a real RTCDataChannel.
