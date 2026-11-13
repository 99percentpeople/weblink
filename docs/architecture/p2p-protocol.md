# P2P control protocol

Once devices have a WebRTC connection, they need an application contract for messages, file requests, permissions, and capabilities. Weblink's control protocol defines these exchanges independently of the UI and storage implementation. Binary file blocks and RTP media have their own data paths.

## Message envelope and routing {#envelope}

Control messages are JSON objects with `id`, `type`, `createdAt`, `client`, and `target`. The ID correlates a request with its reply; the timestamp is Unix time in milliseconds. `client` and `target` identify the sending and receiving peers.

A private text request looks like this:

```json
{
  "id": "message-1",
  "type": "send-text",
  "createdAt": 1760000000000,
  "client": "device-a",
  "target": "device-b",
  "data": "Hello"
}
```

Receivers validate the message type, payload, and connection context before dispatch. Local database and UI fields such as `conversationId`, `deliveries`, and `localSequence` do not belong on the wire. A received object is not inserted directly into application state as a trusted local record.

Room chat uses the separate `send-room-text` message. Its payload carries a room ID and both participants' current room-binding tokens. Devices exchange fresh tokens through `room-capabilities` when the channel opens. The envelope still targets one peer: a room message is delivered separately to online recipients, with its room context checked at each receiver.

## What an acknowledgment means {#acknowledgments}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="P2P request and acknowledgment sequence" tabindex="0">

![A text request is validated and persisted to local history before the receiver returns its ACK. When an ACK is lost, an enabled retry reuses the original ID and can receive the retained reply without running the handler again.](/diagrams/p2p-protocol-en.svg)

</div>
<figcaption>This example follows a chat request. The dashed exchange shows a retry while the receiver still retains its duplicate record; other operations can use typed replies instead of an ACK.</figcaption>
</figure>

For the private text example, the recipient replies with the same ID and reversed peer routing:

```json
{
  "id": "message-1",
  "type": "ack",
  "createdAt": 1760000000010,
  "client": "device-b",
  "target": "device-a",
  "mode": "receive"
}
```

An ACK means the corresponding handler completed successfully. Chat handlers wait for the local history write before acknowledging. That confirms local persistence at that moment; it does not prove that a person read the message, that it will never be deleted, or that the signaling server holds a copy.

Different operations have different reply contracts:

| Operation                                                  | Reply and scope                                                                                 |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `send-text`, `send-room-text`                              | `ack` with `mode: "receive"` after the receive handler completes                                |
| `request-file`, `request-room-file`, `request-shared-file` | `ack` with `mode: "send"` for accepting the send request; file completion is tracked separately |
| Content-based file offers                                  | A typed `file-offer-result`, including whether content can be reused or needs transfer          |
| `request-storage`                                          | A typed `storage` response containing a page of shared-file metadata                            |

Typed responses complete their original request directly. The protocol does not start an endless acknowledgment exchange by acknowledging each reply again.

## Timeouts, retries, and duplicate handling {#request-lifetime}

A request has both a send lifetime and a reply lifetime. Waiting for an available transport or send queue is different from waiting for the recipient after transmission. Cancellation before sending removes the queued request so it cannot appear later. Cancellation after sending cannot undo work the other device has already performed.

When retries are enabled, they reuse a snapshot of the original payload, ID, and timestamp. This keeps one logical operation from becoming several unrelated requests. The receiver coalesces an in-progress duplicate and can replay a completed reply without invoking the handler again.

Duplicate records are bounded: the current defaults are a ten-minute lifetime and at most 512 entries. They live in memory for the protocol session. This is not a permanent exactly-once guarantee across application restarts or expired deduplication records.

Closing the owning session rejects pending requests and aborts its handlers. A late reply from a retired session cannot complete a request on its replacement. Callers distinguish failures such as send timeout, reply timeout, cancellation, closure, and a remote handler error, because they imply different knowledge about whether work reached the peer.

## Capability negotiation {#capabilities}

Devices announce implemented services rather than deriving support from the application version. A `peer-capabilities` message can carry a full snapshot or a patch. This minimal snapshot advertises messaging:

```json
{
  "id": "capabilities-1",
  "type": "peer-capabilities",
  "createdAt": 1760000000000,
  "client": "device-a",
  "target": "device-b",
  "version": 1,
  "update": {
    "kind": "snapshot",
    "generation": "connection-a",
    "revision": 1,
    "services": {
      "messaging/1": {}
    }
  }
}
```

The service key contains its name and major version, such as `messaging/1` or `files/1`. Peers choose a mutually implemented major version for the connection. The capability synchronization envelope has its own version; neither it nor a service major is the WebSocket signaling version.

`generation` binds the announcement to the current connection. A full snapshot establishes the baseline; revisions prevent delayed patches from replacing newer service state. A patch can withdraw a service with `null`, but cannot silently switch the negotiated implementation to a different major version halfway through a connection.

Capabilities describe implementation and current availability. They do not grant authorization. For example, advertising remote control or automation support still leaves the target device's trust, permission, and active-grant checks in place.

## Implementation entry points {#implementation}

Paths are relative to `apps/web/src/libs/domain/protocol/`, a portable module whose imports stay within that directory:

| File                                     | Responsibility                                          |
| ---------------------------------------- | ------------------------------------------------------- |
| `messages.ts`, `validation.ts`           | Wire types and validation                               |
| `request-manager.ts`, `protocol.ts`      | Requests, replies, cancellation, and duplicate handling |
| `transport.ts`                           | Transport boundary used by the protocol                 |
| `capabilities.ts`, `capability-state.ts` | Capability payloads and snapshot/patch application      |
| `protocol-versions.ts`                   | Implemented service versions and negotiation            |

Application handlers connect this contract to local history, file storage, media, and permission services. That separation allows the same exchange rules to be used with browser and desktop transports.

## Choose your next step {#next-steps}

- **Follow a file request into its binary data path:** read [file transfer and resume](file-transfer.md).
- **Understand why a supported operation can still require approval:** read [device identity and authorization](device-trust.md).
- **Use messages and attachments in a room:** follow the [rooms and chat guide](../guide/rooms.md).
