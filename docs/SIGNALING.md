# Signaling Services

Weblink uses signaling only to discover peers and establish WebRTC connections.
Application messages, files, media, display names, and avatars are exchanged
peer-to-peer after WebRTC is ready.

## Implementations

| Service           | Repository                                                                  | Runtime                              | Intended use                                |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------ | ------------------------------------------- |
| Cloudflare Worker | [`weblink-ws-worker`](https://github.com/99percentpeople/weblink-ws-worker) | Cloudflare Workers + Durable Objects | Recommended serverless WebSocket deployment |
| Bun server        | [`weblink-ws-server`](https://github.com/99percentpeople/weblink-ws-server) | Bun, optionally Redis                | Self-hosted or rollback deployment          |

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

### Browser tab ownership

The WebSocket client uses Web Locks, when available, to keep one connection
per signaling endpoint, room and client ID across same-origin tabs. Ownership
survives temporary network reconnects and is released on leave or a failed
initial join. Other rooms and identities remain independent.

A duplicate join shows a page-wide overlay. Only **Switch to this page** sends
a BroadcastChannel takeover request. The previous page leaves the room,
cancels transfers and capture, closes its meeting PiP window, and releases the
lock before the new page connects. The previous page then shows the same
overlay. If it does not respond within five seconds, the switch fails without
stealing its lock and can be retried after closing the unresponsive page.

Blocked pages observe the local lock's availability and attempt a normal join
when the owner closes its tab or leaves the room. Availability checks also resume
on focus/pageshow, and never enqueue ahead of an explicit takeover. The ordinary
exclusive lock still decides the winner when several pages try to recover;
losers keep waiting without opening a WebSocket. Temporary network disconnections
do not release ownership. Manual takeover, leaving, credential changes and app
disposal cancel pending automatic recovery. Restoring the room does not reopen
camera/microphone capture that was stopped by the previous takeover.

Local tab replacement is distinct from server-reported session replacement;
only a verified local conflict enables automatic recovery. Browsers without lock
query support retain the manual switch action.

For older clients or browsers without Web Locks, explicit server close reasons
`Session resumed elsewhere`, `Session replaced` (1000), or `Stale client session`
(1008) stop automatic reconnects. Ordinary network closures still reconnect.
These checks do not change the signaling wire format.

### WebSocket liveness

An open browser WebSocket is not sufficient evidence that signaling is still
reachable. After joining the room, the client sends `{"type":"ping"}` after
15 seconds without incoming traffic and replaces the socket if no response
arrives within 10 seconds. Any incoming frame counts as activity, including
legacy server-driven `ping` messages. The worker already answers this exact
ping envelope through its hibernation auto-response; the signaling wire format
is unchanged.

Focus, visibility restoration, page resume and network-online events probe the
transport immediately. Repeated events do not extend an outstanding probe's
deadline. An unresponsive socket is detached without waiting for its `close`
event, its peer signaling senders become disconnected, and the existing room
resume loop installs a replacement. Heartbeat timers and listeners belong to
that socket and are removed on replacement or room exit. A timeout is logged
as `[WebSocketClientService] heartbeat timeout` separately from SDP/ICE failures.

### Connection logging

Connection code uses native console levels rather than a runtime logger:

| Level   | Purpose                                                                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `info`  | Room signaling ready, WebRTC connected, recovery started, session ownership replaced, explicit room exit.                                                     |
| `warn`  | Socket loss, heartbeat timeout, the first failed WebSocket reconnect, malformed signals, compatibility fallbacks and recoverable failures.                    |
| `error` | SDP processing failures, failed session initialization, unexpected reconnect-loop failures and exhausted peer recovery (including its last error).            |
| `debug` | Individual signals (type and peer ID only), intermediate states, expected offer collisions, stale signals, repeated retries and cancellation/cleanup details. |

Do not log full SDP, ICE candidates, room passwords or peer profile payloads.
Key events include client/peer identifiers where needed to distinguish peers.
The peer session owns connection-state logging; application/UI listeners do not
repeat it. Per-attempt peer failures stay at debug level, while final exhaustion
retains the last failure for production diagnosis.

`vite build` defaults to production mode. In that mode,
`scripts/build-logging.ts` removes `console.log`, `console.debug`,
`console.trace` and `debugger` while retaining `info`, `warn` and `error`.
The main app and Web Workers use Vite's esbuild options; the PWA service-worker
build receives the same options explicitly. Other modes retain verbose logs.
The configuration uses selective `pure` calls, not `drop: ["console"]`, so
argument side effects are preserved and important diagnostics are not removed.

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
acknowledgment arrives, publishes connection readiness, then rebinds every peer signaling channel and replays
the buffer in order. For compatibility with older self-hosted servers, the
frontend falls back to the legacy behavior after a short acknowledgment
timeout.

When a reconnect acknowledgment reports `resumed: false`, the client retires
its old peer sessions before accepting the fresh roster. A peer that left while
ICE configuration was loading cannot be installed by the old pending join.
Restored signaling retries interrupted peer negotiation, including the first
connection, while preserving healthy WebRTC connections. Waiting for signaling
does not consume WebRTC retry attempts; leaving cancels that wait.

The older presence timestamp selects the polite negotiation role; equal
timestamps are resolved using a lexical client-ID comparison. Peers therefore
have opposite roles even when they join in the same millisecond. A simultaneous
offer collision uses polite rollback/answer behavior. Only the impolite side
offers the initial data channel, so colliding offers with different track counts
cannot leave competing SCTP media sections. A polite-only initiation establishes
media first and negotiates the data channel after connection. Each peer
owns at most one automatic recovery loop, and a retired connection's asynchronous
failure cannot disconnect its replacement. Rebuilt peers reuse live local
capture tracks without requesting device permission again. An already-started
incoming negotiation remains pending until WebRTC reports `connected`; the
`connecting` state is not a successful recovery. If the remote peer completes
connection during retry backoff, the next retry preserves that connection.

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

Local SDP application and incoming signals share one per-connection queue.
The controller rechecks signaling state when an operation reaches the queue;
a later queued local intent must not cause an earlier remote offer to be ignored.
Replacing the peer connection detaches the old queue, so a pending retired
browser SDP operation cannot block new signals. Rejecting a colliding offer
with the current generation must not retire that generation: the answer to
the local offer and its ICE candidates still belong to it.

An offer with a new, non-retired generation received on an already negotiated
peer connection is a remote restart, not an ordinary renegotiation. Replace the
old peer connection before applying it, even when local ICE still appears
connected or a local renegotiation is pending. Rebind the existing local capture
tracks and migrate only the new generation's buffered ICE and queued signals.
Initial simultaneous offers still use polite rollback; same-generation media
renegotiation keeps the existing peer connection.

### Negotiation and connection ownership

`PeerSession.replaceConnection` is the only peer-connection creation/replacement
entry, used for initial setup, local recovery and accepted remote restarts.
The room sender subscription belongs to the session and survives transport
replacement. Each peer connection has its own abort lifetime; replacing it
cancels its signaling/connection waits and media/channel listeners. Late native
SDP completions cannot send signaling or mutate the replacement, and an old
pending native promise does not block the new queue.
A valid remote restart supersedes the old automatic recovery attempt. Local
capture and application subscriptions survive; leaving disposes both lifetimes.

Initial connect/recovery explicitly bootstraps `PeerNegotiationController.sendOffer`.
Once an SDP exchange exists, native `negotiationneeded` is the only driver of
local media and data-channel renegotiation, using that same controller/queue.
The media controller only changes tracks and codec preferences; it does not
request offers. Native WebRTC coalesces media changes while an answer is pending.
There is no application dirty flag, stable-event drain, or renegotiation timer.

Offers and answers use no-argument `setLocalDescription()`; the browser chooses,
generates and applies the appropriate description. Signaling sends its resulting
`localDescription` unchanged. Weblink does not parse, normalize or rewrite SDP
header-extension IDs. Native SDP rejections are logged without retrying the same
unchanged offer in a loop or closing an otherwise working media connection.
A failed local offer alone is not evidence that receiving or displaying remote
media has stopped.

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
