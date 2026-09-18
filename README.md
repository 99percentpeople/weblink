<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/branding/weblink-logo-dark.svg" />
    <img src="public/branding/weblink-logo-light.svg" alt="Weblink" width="280" height="89" />
  </picture>

  <p>
    A browser-based P2P chat, file transfer, and file synchronization application powered by WebRTC.
  </p>

  <p>
    <a href="https://github.com/99percentpeople/weblink/actions/workflows/ci.yml">
      <img src="https://github.com/99percentpeople/weblink/actions/workflows/ci.yml/badge.svg" alt="CI" />
    </a>
  </p>

  <p>
    <strong>English</strong> · <a href="README_CN.md">中文</a>
  </p>
</div>

## Introduction

Weblink is a WebRTC-based web application for **file transfer**, **file synchronization**, and **text/voice/video communication**. It runs directly in modern browsers without requiring a native client.

Application data is transferred peer-to-peer after a WebRTC connection is established. A signaling service is used only for peer discovery and WebRTC connection setup. When a room password is configured, signaling payloads are encrypted with that password.

### Public deployments

| Deployment | Signaling backend                    | Address                                  |
| ---------- | ------------------------------------ | ---------------------------------------- |
| Primary    | Cloudflare Workers + Durable Objects | [https://webl.ink](https://webl.ink)     |
| Firebase   | Firebase Realtime Database           | [https://v.webl.ink](https://v.webl.ink) |

The primary deployment uses `wss://ws.webl.ink` for WebSocket signaling. The service is provided by [weblink-ws-worker](https://github.com/99percentpeople/weblink-ws-worker) running on Cloudflare Workers.

## Features

| Feature                       | Description                                                   |
| ----------------------------- | ------------------------------------------------------------- |
| 🔄 **File Synchronization**   | Browse and retrieve files cached by another client.           |
| ⏯️ **Resume Transfer**        | Resume interrupted file transfers.                            |
| 📂 **File Caching**           | Cache transferred files locally in IndexedDB.                 |
| 📁 **Folder Transfer**        | Send folders with automatic packaging and compression.        |
| 📦 **Compressed Transfer**    | Optionally compress files before transfer.                    |
| ⚡ **Multi-Channel Transfer** | Transfer data over multiple WebRTC data channels in parallel. |
| 🔍 **File Search**            | Search files cached locally and by connected peers.           |
| 📋 **Clipboard Transfer**     | Paste clipboard content directly into a chat.                 |
| 💬 **Text Chat**              | Exchange text messages over WebRTC.                           |
| 🎙️ **Voice / Video**          | Share microphones and cameras with connected clients.         |
| 🖥️ **Screen Sharing**         | Share a screen together with system and microphone audio.     |
| 🔗 **Share and Forward**      | Use system sharing after installing Weblink as a PWA.         |

See [CHANGELOG.md](CHANGELOG.md) for recent changes.

## Quick Start

### Requirements

- [Bun](https://bun.sh/)
- A modern browser with WebRTC support

### Install

```bash
git clone https://github.com/99percentpeople/weblink.git
cd weblink
bun install
```

Create `.env.local` and select a signaling backend.

For the public WebSocket signaling service:

```env
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=wss://ws.webl.ink
```

For a locally hosted Bun signaling server:

```env
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=ws://127.0.0.1:9000
```

Then start development:

```bash
bun dev
```

Build the production frontend with:

```bash
bun run build
```

## Signaling Backends

Weblink supports multiple signaling implementations. The signaling service does not carry application messages, files, media, display names, or avatars after the WebRTC connection is ready.

### Cloudflare Workers

The public [webl.ink](https://webl.ink) deployment uses:

```text
wss://ws.webl.ink
```

It is powered by [weblink-ws-worker](https://github.com/99percentpeople/weblink-ws-worker), using Cloudflare Workers and Durable Objects. Each room is mapped to a Durable Object.

### Self-hosted WebSocket server

[weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server) is the Bun-based WebSocket implementation for self-hosted deployments and local/LAN environments.

### Firebase

Firebase Realtime Database remains available as an alternative signaling backend. Configure:

```env
VITE_BACKEND=FIREBASE
VITE_FIREBASE_API_KEY=your-firebase-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-firebase-auth-domain
VITE_FIREBASE_PROJECT_ID=your-firebase-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-firebase-storage-bucket
VITE_FIREBASE_MESSAGING_SENDER_ID=your-firebase-messaging-sender-id
VITE_FIREBASE_APP_ID=your-firebase-app-id
VITE_FIREBASE_DATABASE_URL=your-database-url
```

For protocol details, privacy boundaries, and deployment notes, see [docs/SIGNALING.md](docs/SIGNALING.md).

## Deployment

### Docker

The included `docker-compose.yaml` builds the Weblink frontend together with [weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server).

Update the WebSocket URL and other build arguments in `docker-compose.yaml`, then run:

```bash
docker compose up -d
```

For HTTPS, place `server.crt` and `server.pem` in `docker/ssl`, then enable SSL:

```bash
ENABLE_SSL=true docker compose up -d
```

PowerShell:

```powershell
$env:ENABLE_SSL='true'
docker compose up -d
```

You can also build and deploy the included `Dockerfile` directly.

### Vercel or other static hosting

Configure the required `VITE_*` environment variables in the hosting provider and build the project with:

```bash
bun run build
```

For the public WebSocket service, the minimum signaling configuration is:

```env
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=wss://ws.webl.ink
```

The WebSocket endpoint is a deployment setting and cannot be changed from the application settings UI.

## STUN and TURN

Default STUN and TURN servers can be configured at build time:

```env
VITE_STUN_SERVERS=stun:stun.l.google.com,stun:stun1.l.google.com
VITE_TURN_SERVERS=turn:turn1.example.com:3478|user1|pass1|longterm,turn:turn2.example.com:5349|user2|pass2|hmac
```

A TURN server may be required when direct P2P connectivity is blocked by NAT or firewall rules.

Supported TURN configuration formats:

```text
# coturn with username/password
turn:turn1.example.com:3478|user1|pass1|longterm

# coturn with timestamp/HMAC authentication
turns:turn2.example.com:5349|user2|pass2|hmac

# Cloudflare TURN
name|TURN_TOKEN_ID|API_TOKEN|cloudflare
```

Useful references:

- Public STUN server list: [mondain/public-stun-list](https://gist.github.com/mondain/b0ec1cf5f60ae726202e)
- Cloudflare TURN: [Cloudflare Calls TURN](https://developers.cloudflare.com/calls/turn/)
- Self-hosted TURN: [coturn](https://github.com/coturn/coturn)

## LAN Usage

Weblink can be used inside a LAN. Ensure the devices can reach each other and that local firewall rules do not block WebRTC traffic.

For a fully local setup, run [weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server) and point `VITE_WEBSOCKET_URL` to the local signaling server before building the frontend.

## Contributing

Contributions are welcome. Feel free to open an issue or submit a pull request.

## License

Weblink is released under the [MIT License](LICENSE).
