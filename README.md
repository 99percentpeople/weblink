# Weblink

[![CI](https://github.com/99percentpeople/weblink/actions/workflows/ci.yml/badge.svg)](https://github.com/99percentpeople/weblink/actions/workflows/ci.yml)

**English Introduction** | [**中文介绍**](README_CN.md)

## Introduction

Weblink is a pure web-based **file transfer** and **text/voice/video chat** application built on WebRTC. It requires no downloads and works directly in your browser. Utilizing a serverless P2P architecture, it supports multiple backends including Firebase, WebSocket for efficient peer-to-peer connections. Additionally, Weblink ensures the privacy and security of signaling messages through end-to-end encryption.

The project is deployed on Cloudflare Pages and using Firebase as backend can be accessed at [https://v.webl.ink](https://v.webl.ink).

Alternatively, you can use the version using self-hosted WebSocket as backend at [https://webl.ink](https://webl.ink).

## 🌟Features

Weblink currently supports the following features:

| **Feature**                   | **Description**                                                                           |
| ----------------------------- | ----------------------------------------------------------------------------------------- |
| 🔄 **File Synchronization**   | Retrieve cached files from the other party seamlessly.                                    |
| ⏯️ **Resume Transfer**        | Resume file transfer effortlessly if the connection is interrupted.                       |
| 📂 **File Caching**           | Transferred files are securely cached in IndexedDB.                                       |
| 🖥️ **Screen Sharing**         | Share screens, cameras, and audio (include speaker and microphone) with multiple clients. |
| 🔍 **File Search**            | Quickly search for cached files from you and the other party.                             |
| 📋 **Clipboard Transfer**     | Paste clipboard content directly into the chat with `Ctrl + V` or mobile paste actions.   |
| 📁 **Folder Transfer**        | Send folders effortlessly with automatic compression.                                     |
| 📦 **Compressed Transfer**    | Choose to compress files during transfer for efficient data handling.                     |
| ⚡ **Multi-Channel Transfer** | Boost transfer performance with parallel data transfers across multiple channels.         |
| 🔗 **Share and Forward**      | Share text or files via system sharing after installing as a PWA.                         |
| 💬 **Text Chat**              | Exchange text messages for smooth communication.                                          |

More information can be found in [CHANGELOG](CHANGELOG.md).

## Usage

### Run Locally (Development)

```bash
git clone https://github.com/99percentpeople/weblink.git
cd weblink
bun install
```

Make sure you configure the Firebase keys in the project (as shown below), then run the following command:

```bash
# Development
bun dev
# Build
bun build
```

### Deploy to Docker

You can deploy this project to Docker using `docker-compose.yaml`, and it will automatically build the [weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server) as backend.

Modify the `docker-compose.yaml` file to set the correct environment variables. Then run the following command:

```bash
docker compose up -d
```

To enable SSL you need to provide the SSL certificate `server.crt` and key `server.pem` files in the `docker/ssl` directory. And run the following command:

```bash
ENABLE_SSL=true && docker compose up -d
```

```pwsh
$env:ENABLE_SSL='true' && docker compose up -d
```

Alternatively, you can also use Dockerfile to deploy this project to Docker.

### Deploy to Vercel

To deploy this project to Vercel, follow these steps:

1. Go to the Vercel website and log in (or create an account).

2. Connect your GitHub repository and select the cloned repository.

3. In your Vercel project settings, find "Environment Variables" and add the Firebase API key and other environment variables (as shown below).

4. Click the "Deploy" button, and Vercel will automatically build and deploy your project.

### Environment Variables Configuration (Firebase)

You will need to configure Firebase keys for both local development and deployment to Vercel. Add the following Firebase environment variables:

```env
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID
VITE_FIREBASE_DATABASE_URL
```

### Vercel Environment Variables Configuration

For Vercel deployment, set the environment variables by following these steps:

1. Open your Vercel project and go to "Settings."

2. Find "Environment Variables."

3. Add the Firebase configuration items above and input the corresponding values.

### WebSocket Signaling

For a serverless deployment, use [weblink-ws-worker](https://github.com/99percentpeople/weblink-ws-worker), which runs on Cloudflare Workers and maps each room to a Durable Object. The Bun-based [weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server) remains available for self-hosting and rollback.

The WebSocket endpoint is fixed at build time with `VITE_WEBSOCKET_URL`; users cannot override it in the settings UI. See [Signaling Services](docs/SIGNALING.md) for the protocol boundary, privacy model, deployment, validation, and rollback procedure.

### Local Environment Variables (.env.local)

For local development, create a .env.local file and add the Firebase keys:

```env
# backend choose FIREBASE, WEBSOCKET

# FIREBASE
VITE_BACKEND=FIREBASE
VITE_FIREBASE_API_KEY=your-firebase-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-firebase-auth-domain
VITE_FIREBASE_PROJECT_ID=your-firebase-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-firebase-storage-bucket
VITE_FIREBASE_MESSAGING_SENDER_ID=your-firebase-messaging-sender-id
VITE_FIREBASE_APP_ID=your-firebase-app-id
VITE_FIREBASE_DATABASE_URL=your-database-url

# WEBSOCKET
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=wss://ws.webl.ink
```

## Notes

### STUN and TURN Server Configuration

You can configure multiple default STUN and TURN servers for this application, and users do not need to manually configure them. The configuration is as follows in the .env.local file:

```env
# Multiple STUN and TURN servers, separated by commas
VITE_STUN_SERVERS=stun:stun.l.google.com,stun:stun1.l.google.com
VITE_TURN_SERVERS=turn:turn1.example.com:3478|user1|pass1|longterm,turn:turn2.example.com:5349|user2|pass2|hmac
```

If you are using P2P connections outside a local area network (in a NAT environment), you may need to configure a TURN server to ensure connections are established. In the settings page, you can configure the TURN server with the following format, support coturn and Cloudflare TURN server, and separate multiple configurations with newline characters:

**TURN Configuration Format:**

```plaintext
# use coturn with account and password
turn:turn1.example.com:3478|user1|pass1|longterm
# use coturn with timestamp
turns:turn2.example.com:5349|user2|pass2|hmac
# use cloudflare turn server
name|TURN_TOKEN_ID|API_TOKEN|cloudflare
```

Here are some methods to get public STUN and TURN servers:

#### Public STUN Server

This application defaults to using Google's STUN server. If you cannot connect, please configure your own STUN server. You can refer to [https://gist.github.com/mondain/b0ec1cf5f60ae726202e](https://gist.github.com/mondain/b0ec1cf5f60ae726202e) for a list of public STUN servers. Then add the stun server in format `stun:xxxx:xxxx` to the STUN server list in the settings page such as `stun:stun.l.google.com:19302`.

#### Cloudflare Calls TURN Server

You can use the TURN server provided by Cloudflare Calls, please visit [https://developers.cloudflare.com/calls/turn](https://developers.cloudflare.com/calls/turn). Then add the TURN server in format `name|TURN_TOKEN_ID|API_TOKEN|cloudflare` to the TURN server list in the settings page.

#### Self-Hosted STUN/TURN Server

You can refer to [https://github.com/coturn/coturn](https://github.com/coturn/coturn) to set up your own TURN server.

### Use in LAN

The application currently supports LAN use in non-secure environments. Ensure that your devices are in the same LAN and the firewall does not block P2P connections.

And at the same time, run [weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server) to support WEBSOCKET connections.

## Contribution

Contributions are welcome! Please feel free to submit issues or pull requests.

## License

This project is open-sourced under the [MIT License](LICENSE).
