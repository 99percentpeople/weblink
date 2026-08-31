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
- `join` / `leave`
- `message` for SDP offers/answers and ICE candidates
- `ping` / `pong`
- reconnect with a 90-second message cache

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

## Frontend configuration

The WebSocket endpoint is a build-time deployment setting:

```env
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=wss://ws.webl.ink
```

Users cannot override the signaling URL in the settings UI. Legacy
`localStorage` values named `websocketUrl` are ignored. Changing the endpoint
requires updating the deployment environment and rebuilding the frontend.

## Worker development and deployment

```bash
git clone https://github.com/99percentpeople/weblink-ws-worker.git
cd weblink-ws-worker
bun install
bun run typegen
bun run format:check
bun run typecheck
bun run test
bunx wrangler deploy --dry-run
```

Authenticate and deploy only after the checks pass:

```bash
# Device flow works in remote SSH environments.
bunx wrangler login --device
bun run deploy
```

The custom domain is declared in the Worker repository's `wrangler.jsonc`.
Wrangler provisions the Cloudflare route, DNS record, and TLS certificate.
Verify both HTTP and WebSocket behavior after deployment:

```bash
curl https://ws.webl.ink/healthcheck
```

## Migration and rollback

Keep the Bun deployment available while validating Cloudflare connectivity.
Before changing `VITE_WEBSOCKET_URL`, test room joins, reconnects, and WebRTC
negotiation from the target networks, including mainland carrier networks.

Switching signaling providers requires only a frontend rebuild. If the
Cloudflare endpoint is unstable, restore the previous Bun WebSocket URL and
redeploy the frontend; no user-side signaling setting needs to be migrated.
