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

The canonical TypeScript wire DTOs and request policy are in
`domain/protocol/messages.ts`. Runtime validation is in
`domain/protocol/validation.ts`.

## Request types and ACK policy

The request policy is defined once by `requestSpec`:

| Request           | Reply behavior                      |
| ----------------- | ----------------------------------- |
| `send-text`       | `ack` mode `receive`                |
| `send-clipboard`  | `ack` mode `receive`                |
| `send-file`       | `ack` mode `receive`                |
| `request-file`    | `ack` mode `send`                   |
| `resume-file`     | `ack` mode `receive`                |
| `request-storage` | `storage` response plus receipt ACK |

An ACK means the receiving request handler completed successfully. It does
**not** mean durable database storage, file-transfer completion, clipboard
permission or that a human read a message.

Typical use:

```ts
const receipt = await protocol.call(session, "send-text", {
  data: "Hello",
});

const files = await protocol.call(
  session,
  "request-storage",
  {},
);

const stopHandling = protocol.handle(
  "request-storage",
  async ({ session, signal }) => {
    // Apply local authorization/policy here.
    return [];
  },
);
```

`request-storage` returns portable file metadata DTOs. It never exposes a
browser `File`, IndexedDB record or cache implementation.

## Notifications

Notifications do not wait for a remote ACK:

- `client-profile`
- `stream-state`
- `read-text`

```ts
await protocol.notify(session, "client-profile", {
  profile: {
    name: "Alice",
    avatar: null,
  },
});

await protocol.notify(session, "stream-state", {
  mode: "media",
});
```

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

`storage` replies use portable metadata with `mimetype`, matching the
existing wire format. Browser-only fields such as `File`, cache handles and
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

## Verification

- `bun run lint`: strict TypeScript checking.
- `bunx vitest run`: unit/integration suite.
- `bun run test:protocol`: real Chromium DataChannel control-protocol harness.
- `test/protocol-portability.test.ts`: runs `P2PProtocol` with a plain session
  object and custom non-PeerSession transport.
- `bun run build`: production bundle validation.
