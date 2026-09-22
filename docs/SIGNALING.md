# Signaling Services

Weblink uses signaling only to discover peers and establish WebRTC connections.
Application messages, files, media, display names, and avatars are exchanged
peer-to-peer after WebRTC is ready.

## Implementations

| Service           | Repository                                                                  | Runtime                              | Intended use                                |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------- |
| Cloudflare Worker | [`weblink-ws-worker`](https://github.com/99percentpeople/weblink-ws-worker) | Cloudflare Workers + Durable Objects | Recommended serverless WebSocket deployment |
| Bun server        | [`weblink-ws-server`](https://github.com/99percentpeople/weblink-ws-server) | Bun, optionally Redis                | Self-hosted or rollback deployment          |
| Firebase          | This repository                                                             | Firebase Realtime Database           | Alternative managed backend                 |

The deployed Cloudflare candidate endpoints are:

- Health check: `https://ws.webl.ink/healthcheck`
- WebSocket: `wss://ws.webl.ink`
- Workers.dev fallback: `https://weblink-signaling.myzzzyearz-e00.workers.dev`

## Cloudflare room model

The Worker maps each room ID to one `SignalingRoom` Durable Object. A room
object owns its membership, password hash, WebSocket attachments, reconnect
grace period, and queued signaling messages. It uses the WebSocket Hibernation
API so idle rooms do not require a continuously active Worker instance.

The Worker supports the existing Weblink WebSocket protocol:

- `connected`
- `join`, followed by a versioned `joined` acknowledgment
- `leave`
- `message` for SDP offers/answers and ICE candidates
- `ping` / `pong`
- reconnect with a 90-second message cache

## Portable signaling contract

The frontend's transport-neutral signaling DTOs, parser and deployed limits live
in `src/libs/domain/signaling-protocol.ts`. Browser reconnect timers and
WebSocket lifecycle state remain infrastructure concerns and are intentionally
not part of this contract.

The deployed WebSocket signaling contract currently uses protocol version **2**
and these limits:

| Limit                               |            Value |
| ----------------------------------- | ---------------: |
| client ID length                    |   128 characters |
| room ID length                      |   256 characters |
| password-hash length                | 1,024 characters |
| one encoded signaling message       |            1 MiB |
| cached reconnect signals per client |              256 |

Every WebSocket signaling frame is a JSON envelope:

```json
{
  "type": "message",
  "data": {}
}
```

The public presence shape is:

```json
{
  "clientId": "peer-id",
  "createdAt": 1760000000000,
  "rtcProfileVersion": 1,
  "resume": true
}
```

Only `clientId` and `createdAt` are required. Profile display data is not part
of presence.

A routed peer signaling frame has:

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

The signaling backend validates ownership of `clientId` and routes only by
sender/target identity. It treats the nested `data` payload as opaque. Weblink's
browser client may encrypt that payload with the room password before sending
SDP/ICE objects.

For future native clients the required lifecycle is:

1. Open the WebSocket with `room` and optional `pwd` query parameters.
2. Wait for `connected` and validate the returned room password hash locally.
3. Send `join` with public presence.
4. On protocol-v2 servers, wait for `joined` before treating membership as
   installed or replaying peer work.
5. Handle `join` / `leave` presence frames and routed `message` frames.
6. Reply to `ping` with `pong`.
7. Reconnect with the same client ID and `resume: true` when attempting to
   recover the retained session.
8. Never reuse an old socket after a replacement connection owns that client ID.

Both WebSocket backends maintain an internal per-connection ownership token.
That token is not part of the public wire format. It prevents late
message/leave/close events from an old socket from mutating the replacement
session; the Worker also persists the token through Durable Object hibernation.

The Bun server and Worker still live in independent Git repositories, so their
contract tests currently execute in each repository. A future shared fixture
must be distributed through a CI-consumable package/spec source rather than a
local sibling-repository path.

### Room join acknowledgment

After password validation, the client sends `join`. Protocol version 2 servers
reply only after room membership has been installed:

```json
{
  "type": "joined",
  "data": {
    "protocolVersion": 2,
    "resumed": true
  }
}
```

`resumed` is `true` only when the server recovered the retained session. The
server sends this acknowledgment before existing-client presence or cached
SDP/ICE signals. The frontend buffers room and peer signals until the
acknowledgment arrives, then rebinds every peer signaling channel and replays
the buffer in order. For compatibility with older self-hosted servers, the
frontend falls back to the legacy behavior after a short acknowledgment
timeout.

### WebRTC connection generations

Each new `RTCPeerConnection` creates a random connection `generation`. The
frontend includes it inside the encrypted JSON payload for SDP offers, answers,
and ICE candidates:

```json
{
  "sdp": "...",
  "generation": "b86d7dca-..."
}
```

The peer that accepts an offer adopts its generation and echoes it in the
answer and local ICE candidates. Candidates received before the matching offer
are queued by generation. When a peer connection is replaced, its generation
is retired so delayed answers and candidates from the old connection cannot
pollute the replacement. Payloads without `generation` remain accepted for
compatibility with older clients.

The signaling backends treat this encrypted payload as opaque data; no backend
protocol change is required for connection generations.

## Privacy boundary

Signaling presence is deliberately limited to connection metadata:

- `clientId`
- `createdAt`
- `rtcProfileVersion`
- `resume`, when reconnecting

`name` and `avatar` are not part of signaling presence. Both WebSocket
backends discard these fields if a legacy or modified client sends them.
Frontend signaling clients also ignore legacy profile fields and create a
local anonymous placeholder until the versioned `client-profile` message
arrives through the WebRTC DataChannel.

The signaling service can still observe room membership, client IDs, and the
timing of connection setup. SDP offers/answers and ICE candidates must pass
through signaling before WebRTC exists, but Weblink encrypts signaling payloads
with the room password.

## Deployment

Frontend environment variables, static hosting, Docker, Cloudflare Worker
deployment, Bun server deployment, ICE configuration, LAN setup and rollout
checks are centralized in [DEPLOYMENT.md](DEPLOYMENT.md).

This document intentionally keeps only signaling architecture, wire behavior,
privacy boundaries and reconnect/session ownership semantics.
