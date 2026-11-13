# Signaling and session recovery

Weblink uses WebSocket signaling to establish and recover device connections. Chat, file bytes, and media then travel over WebRTC. This article follows the signaling handshake, explains how reconnects retain the right session, and separates backend state from content delivery.

## Join is a handshake {#join}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="Room handshake and reconnect diagram" tabindex="0">

![Client A joins signaling, receives joined before members and cached signals, and negotiates with Client B. WebRTC carries content after pairing. A resumed session keeps healthy peers; a fresh join retires old peer state.](/diagrams/signaling-en.svg)

</div>
<figcaption>Read the exchange from top to bottom. The two reconnect outcomes depend on the backend's joined acknowledgment, not just the client's resume request.</figcaption>
</figure>

A connected WebSocket is only the transport. The client must finish the room handshake before it can treat the room as joined:

1. Connect to the configured WS/WSS endpoint with the room ID and optional room-password information.
2. Wait for `connected`, check the room's password information, and supply the required identity proof when challenged.
3. Send `join` with the local presence record. Presence includes `clientId` and `createdAt`; a reconnect can request `resume: true`.
4. Wait for a valid `joined` response. The current shared signaling protocol version is **2**.
5. Process the existing member list and routed negotiation messages.

The acknowledgment explicitly says whether the backend restored a retained session:

```json
{
  "type": "joined",
  "data": {
    "protocolVersion": 2,
    "resumed": true
  }
}
```

The backend sends this acknowledgment before the member list and cached signals. This ordering lets the client decide whether to preserve or retire its previous peer state before applying those messages. Opening a socket or sending `join` alone is not evidence of successful room membership.

## Routing SDP and ICE {#routing}

An SDP offer or answer describes the proposed connection and media. ICE candidates describe possible network paths. Both use the signaling service to reach the other device; the service does not create the peer connection on either device's behalf.

A routed frame has this shape. The nested string below is a placeholder for the actual negotiation payload, not an SDP example:

```json
{
  "type": "message",
  "data": {
    "type": "offer",
    "clientId": "sender-id",
    "targetClientId": "receiver-id",
    "sessionId": "optional-session-id",
    "data": "opaque-or-encrypted-payload"
  }
}
```

The backend checks ownership of the sending `clientId` and routes to `targetClientId`. It treats the nested payload as opaque. Password-protected clients can encrypt negotiation data with the room password; this does not hide room membership, client IDs, or message timing from the service.

The wire contract also includes `leave` and `ping` / `pong`. Display names and avatars are exchanged through the peer connection rather than being part of the public presence record. A room password controls room admission; device pairing and operation permissions are separate decisions.

## Recovering without reviving an old session {#recovery}

There are several different identities in a connection. Keeping them separate prevents a delayed callback or packet from affecting a replacement connection.

| Identity or state     | Purpose                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `clientId`            | Identifies a participant in room signaling                           |
| Socket ownership      | Lets the backend distinguish the current socket from one it replaced |
| Connection generation | Binds negotiation and peer state to the current connection attempt   |
| Optional `sessionId`  | Routes signaling for a particular peer session                       |

Socket ownership is backend state, not an extra field callers should insert into every frame. A late close or leave from an old socket must not remove the member now owned by its replacement.

On reconnect, `resumed: true` means the service actually recovered retained state. `resumed: false` tells the client to retire old peer state before applying the fresh roster. Requesting a resume does not guarantee that the backend still has it.

A temporary signaling interruption does not itself require destroying healthy WebRTC connections. New negotiations and failed-peer recovery need signaling again. Once it returns, the client coordinates recovery from that event instead of continually creating peer connections while signaling is unavailable. Cancelling or replacing a session also cancels its pending work.

## Simultaneous offers and stale candidates {#negotiation}

Both devices can try to negotiate at once. Weblink assigns deterministic polite and impolite roles using presence ordering, with client IDs breaking ties. The polite side can roll back its competing local offer; the other side can ignore a colliding offer. This gives both devices a consistent way to resolve the collision.

Negotiation also tracks a connection generation through `connectionId`. ICE from an older generation must not be applied to a newly created peer connection simply because its sender has the same client ID. These rules matter during rapid reconnects, network changes, and concurrent media updates.

Successful SDP exchange still leaves WebRTC to find a usable path. STUN assists address discovery, and TURN provides a relay when needed. Neither an online room member nor a successful `joined` acknowledgment proves that the selected media codec can be decoded.

## What the backend retains {#backend-state}

The Bun Server and the Cloudflare Worker implement the same client-facing signaling contract. In the Worker implementation, each room has a Durable Object that owns membership, password information, WebSocket attachments, and bounded reconnect state. WebSocket hibernation allows an idle room to stop actively executing while retaining its connections.

Queued reconnect messages are negotiation messages. They do not provide offline chat, a file archive, or media recording. Reconnect state is bounded and temporary; a client must be able to join afresh when that state is gone.

## Implementation entry points {#implementation}

Paths are relative to the repository root:

| Path                                                     | Responsibility                                            |
| -------------------------------------------------------- | --------------------------------------------------------- |
| `apps/web/src/libs/domain/signaling-protocol.ts`         | Portable envelopes, parsing, protocol version, and limits |
| `apps/web/src/libs/infrastructure/signaling/`            | WebSocket transport, handshake, and reconnect handling    |
| `apps/web/src/libs/application/room-service.ts`          | Room membership and lifecycle coordination                |
| `apps/web/src/libs/application/rtc/rtc-service.ts`       | Peer connection negotiation and recovery                  |
| `servers/weblink-ws-server`, `servers/weblink-ws-worker` | Alternative signaling backends                            |

## Choose your next step {#next-steps}

- **Understand what devices exchange after connecting:** continue with the [P2P control protocol](p2p-protocol.md).
- **Choose your own signaling or relay services:** use the [self-hosting overview](../deployment/overview.md).
- **Find why members appear but content does not connect:** follow the [WebRTC connection checks](../guide/faq.md#peer-connection).
