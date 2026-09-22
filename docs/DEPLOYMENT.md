# Deployment

This document contains local setup, build-time configuration, frontend hosting,
signaling backend selection, Docker deployment, ICE configuration, and LAN notes.

For signaling protocol behavior and backend architecture, see
[SIGNALING.md](SIGNALING.md). For test commands, see [TESTING.md](TESTING.md).

## Requirements

For local development or building from source:

- [Bun](https://bun.sh/)
- a modern browser with WebRTC support
- a signaling backend

Install dependencies:

```sh
git clone https://github.com/99percentpeople/weblink.git
cd weblink
bun install
```

Start the development server:

```sh
bun dev
```

Build the production frontend:

```sh
bun run build
```

The static production output is written to `dist/`.

## Signaling backend

Choose the frontend signaling implementation with `VITE_BACKEND`.

### WebSocket

Recommended configuration:

```env
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=wss://ws.webl.ink
```

For a local Bun signaling server:

```env
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=ws://127.0.0.1:9000
```

Available WebSocket backends:

- [weblink-ws-worker](https://github.com/99percentpeople/weblink-ws-worker) —
  Cloudflare Workers + Durable Objects.
- [weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server) —
  Bun server for self-hosting and LAN deployments.

The WebSocket URL is a deployment setting, not an end-user setting.

The frontend normally reads `VITE_WEBSOCKET_URL` at build time. The included
Docker image also supports replacing that value at container startup through
`window.env.VITE_WEBSOCKET_URL` in `index.html`.

### Firebase

Firebase Realtime Database remains available as an alternative signaling
backend:

```env
VITE_BACKEND=FIREBASE
VITE_FIREBASE_API_KEY=...
VITE_FIREBASE_AUTH_DOMAIN=...
VITE_FIREBASE_PROJECT_ID=...
VITE_FIREBASE_SOTRAGE_BUCKET=...
VITE_FIREBASE_MESSAGEING_SENDER_ID=...
VITE_FIREBASE_APP_ID=...
VITE_FIREBASE_MEASUREMENT_ID=...
VITE_FIREBASE_DATABASE_URL=...
```

The `SOTRAGE` and `MESSAGEING` spellings above intentionally match the
current environment-variable names used by the code. Do not silently replace
them with differently spelled variables unless the application code is migrated
at the same time.

## STUN and TURN

Default ICE servers can be supplied at build time.

STUN servers are comma-separated:

```env
VITE_STUN_SERVERS=stun:stun.l.google.com,stun:stun1.l.google.com
```

TURN entries use four pipe-separated fields:

```text
url|username|password|authMethod
```

Multiple entries are separated by newlines in the parsed configuration. For
shell/build environments that provide one string, preserve the same format
expected by the deployment environment.

Supported authentication methods:

```text
turn:turn.example.com:3478|user|password|longterm
turns:turn.example.com:5349|user|secret|hmac
name|TURN_TOKEN_ID|API_TOKEN|cloudflare
```

A TURN relay may be required when NAT or firewall policy prevents a direct P2P
path.

References:

- [coturn](https://github.com/coturn/coturn)
- [Cloudflare TURN](https://developers.cloudflare.com/calls/turn/)
- [Public STUN list](https://gist.github.com/mondain/b0ec1cf5f60ae726202e)

## Static hosting

Weblink's frontend is a static Vite build.

For Vercel, Cloudflare Pages, Netlify, or another static host:

1. configure the required `VITE_*` variables;
2. install dependencies with Bun;
3. run `bun run build`;
4. publish `dist/`.

A minimal public WebSocket deployment needs:

```env
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=wss://ws.webl.ink
```

Use HTTPS in production. Browser media APIs, PWA behavior, clipboard features,
and secure WebSocket deployment all work most reliably in a secure context.

## Docker

The repository includes a frontend `Dockerfile` and
`docker-compose.yaml`.

The compose file builds the frontend and starts
[weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server).

Before starting it, set the public WebSocket address in
`docker-compose.yaml` to an address browsers can actually reach.

Then run:

```sh
docker compose up -d
```

The current frontend Dockerfile declares build arguments for:

- `VITE_WEBSOCKET_URL`
- `VITE_STUN_SERVERS`

`VITE_BACKEND` defaults to `WEBSOCKET` in the image.

If additional build-time variables such as `VITE_TURN_SERVERS` are required,
ensure they are exposed to the Docker build stage as well as supplied by the
compose/CI environment.

### HTTPS with the included nginx image

Place these files under `docker/ssl/`:

```text
server.crt
server.pem
```

Then start with SSL enabled:

```sh
ENABLE_SSL=true docker compose up -d
```

PowerShell:

```powershell
$env:ENABLE_SSL='true'
docker compose up -d
```

At container startup the nginx entrypoint also substitutes environment values
into the built `index.html`, including the runtime WebSocket URL.

## Cloudflare signaling Worker

The public WebSocket signaling service is maintained in the separate
[weblink-ws-worker](https://github.com/99percentpeople/weblink-ws-worker)
repository.

Typical verification before deployment:

```sh
bun install
bun run typegen
bun run format:check
bun run typecheck
bun run test
bunx wrangler deploy --dry-run
```

Authenticate and deploy from that repository:

```sh
bunx wrangler login --device
bun run deploy
```

The Worker repository owns its Durable Object and custom-domain configuration.

## Bun signaling server

For self-hosting or a fully local deployment, use
[weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server).

Point the frontend at the reachable server URL before building or through the
Docker runtime WebSocket URL:

```env
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=ws://192.168.1.20:9000
```

Use `wss://` when the frontend itself is served over HTTPS.

## LAN deployment

Weblink can run entirely inside a LAN.

Requirements:

- peers can reach the frontend;
- peers can reach the signaling server;
- local firewall policy allows the required WebRTC traffic;
- STUN/TURN settings fit the target network.

For a simple LAN deployment, run the Bun signaling server on a reachable host
and build the frontend with that host's LAN WebSocket URL.

Do not use `127.0.0.1` or `localhost` in a frontend configuration intended
for other devices: those addresses resolve to each device itself.

## Production checklist

Before switching users to a new deployment:

1. Build and run the frontend correctness checks from [TESTING.md](TESTING.md).
2. Verify the selected signaling backend's own test suite.
3. Confirm the browser-visible WebSocket URL is reachable from the target
   networks.
4. Test room join, reconnect, and session replacement.
5. Verify at least one real peer-to-peer file transfer.
6. Verify TURN fallback if the deployment depends on relayed connectivity.
7. Confirm HTTPS/WSS certificate validity for public deployments.
8. Keep the previous signaling endpoint available until the new endpoint has
   been validated on the intended networks.

Changing signaling provider requires a frontend deployment/configuration change,
but does not require migrating user file caches or message history.
