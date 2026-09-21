# P2P control protocol

The message DataChannel has one asynchronous application API. File payloads and
speed-test traffic keep their own channels and state machines. The control wire
format is unchanged; this refactor does not require a signaling-server update.

## Calling and handling requests

```ts
const protocol = createRtcProtocol();

const receipt = await protocol.call(session, "send-text", {
  data: "Hello",
});

// Inferred as ChunkMetaData[], not an ACK or a global-state side effect.
const files = await protocol.call(
  session,
  "request-storage",
  {},
);

const stopHandling = protocol.handle(
  "request-storage",
  async ({ session, signal }) => {
    // Apply the owning peer's authorization/configuration here.
    // Observe signal around asynchronous work that must stop on session teardown.
    return [];
  },
);
```

`call()` accepts only request methods. It supplies the ID, timestamp and peer
addresses, validates and snapshots the message, and correlates the response to
the actual `PeerSession` instance. `handle()` permits one handler per method.
ACK modes are defined once in `core/protocol/messages.ts`, not at registration
sites. Handler failures produce a protocol error reply.

Ordinary calls return an `AckMessage`. The ACK means the receiving handler
returned successfully: it is **not** a guarantee of durable database storage,
clipboard permission, file-transfer completion, or a user having read the text.
A `send-file`/`request-file` ACK completes the setup request; transfer progress
and completion remain owned by the transfer/task services.

`request-storage` returns the file list. Its `storage` response and the existing
bidirectional ACK exchange are handled inside the protocol, including duplicate
response acknowledgments and cached response replay. Application handlers simply
return the authorized list; returning `[]` preserves the disabled-file-list behavior.

## Notifications

```ts
await protocol.notify(session, "client-profile", {
  profile,
});
await protocol.notify(session, "stream-state", {
  mode: "media",
});

const stopListening = protocol.on(
  "client-profile",
  ({ session, message }) => {
    // Update the matching peer's display metadata.
  },
);
```

`notify()` accepts notification types only and does not wait for a remote ACK.
Its promise resolves after `RTCDataChannel.send()` accepts the serialized message
into the browser's send buffer. The same local-send meaning applies to
`PeerSession.sendMessage()`, which now returns `Promise<void>`.

## Timeouts, cancellation and errors

| Option          | Default   | Meaning                                                 |
| --------------- | --------- | ------------------------------------------------------- |
| `sendTimeoutMs` | 10,000 ms | Maximum time waiting to write to the message channel.   |
| `timeoutMs`     | 5,000 ms  | Reply deadline, starting after actual `send()` success. |
| `retries`       | 0         | Additional attempts after a reply timeout.              |
| `retryDelayMs`  | 250 ms    | Delay before another attempt.                           |
| `signal`        | None      | Cancels waiting, queued sends and retry timers.         |

```ts
const controller = new AbortController();
const files = await protocol.call(
  session,
  "request-storage",
  {},
  {
    signal: controller.signal,
    sendTimeoutMs: 10_000,
    timeoutMs: 5_000,
  },
);
```

An expired or cancelled **unsent** request is removed from the queue and cannot
be replayed when the channel recovers. Closing/unbinding a session rejects its
pending requests immediately, aborts handler lifetimes and releases its caches.
Replacing a session cannot let an old response settle a new session's request.

After a message has already been sent, cancellation or timeout does not undo the
remote operation. Retrying preserves the same frozen payload, ID and timestamp.
Successful handlers are deduplicated within the session's bounded in-memory
cache (512 entries, using `RTC_PROTOCOL_DEDUP_TTL_MS`). This is not a persistent
exactly-once guarantee across reloads, new sessions, cache expiry or eviction.

Failures are `RtcProtocolError` instances with `code`: `already-pending`,
`timeout`, `send-timeout`, `aborted`, `closed`, `remote-error`, `send-failed` or
`invalid-message`. Invalid local timeout/retry options raise `RangeError`.

## Chat/message-state integration

`PeerMessagingService.send()` handles tracked `send-text`, `send-file` and
`request-file` operations. It uses the common `call()` lifecycle to create the
local message before sending, disable the message store's duplicate timeout,
and record the ACK or failure exactly once for that attempt.

```ts
const messaging = new PeerMessagingService(
  protocol,
  messageStores,
);
const acknowledged = await messaging.send(
  session,
  "send-file",
  fileMetadata,
);
if (acknowledged) {
  // Continue transfer setup with acknowledged.message and acknowledged.ackMessage.
}
```

For retries, pass the original `id` and `createdAt` with `retry: true`. Normal
tracked failures return `null` after recording the local error. Nested remote
commands use `throwOnError: true` so a failed reverse file request cannot be
reported as a successful resume operation.

`RtcCallOptions.onPrepared` is the tracking hook; it receives the frozen outgoing
message once, after the pending slot is reserved. Do not mutate that message.
Application UI code should use the messaging/service boundary rather than build
wire envelopes, register ACK listeners, or maintain its own request timers.

## Module ownership

- `core/protocol/messages.ts`: wire types, request policy and message creation.
- `core/protocol/validation.ts`: runtime parsing, peer checks and immutable snapshots.
- `core/protocol/send-queue.ts`: actual-send promises and cancel-safe queue ownership.
- `core/protocol/request-manager.ts`: pending requests, reply matching, dedup and teardown.
- `services/rtc-service.ts`: session/channel event routing and asynchronous transport.
- `services/rtc-protocol.ts`: typed `call`, `notify`, `handle` and `on` facade.
- `services/peer-messaging-service.ts`: chat history/status integration.

Runtime validation checks the envelope, message-specific payload, numeric file
metadata and chunk ranges. Both sender and target must match the owning session
before handlers or pending requests are touched.

## Verification

Run the complete configured suite with `bun run test --run`, strict type checking
with `bun run lint`, and the production build with `bun run build`.

`bun run test:protocol` exercises actual Chromium DataChannels without joining a
real room. It covers pre-open queueing, expired/cancelled message removal, typed
storage replies, file-request ACK modes, concurrent calls, notifications and
pending-call rejection on channel close. Chromium can be selected with
`CHROMIUM_PATH`; the harness uses a temporary browser profile and loopback peers.
