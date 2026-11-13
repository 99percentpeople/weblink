# Web deployment

Use this guide to run Weblink on your own server or hosting platform. The frontend provides the web interface, while the backend handles device discovery and connection negotiation. Messages, files, and media travel between devices over WebRTC.

Hosting the frontend is optional. To use your own signaling service with the existing website or desktop app, start with the [self-hosting overview](overview.md#signaling-only).

| Deployment method                      | Order                                                                                                                    |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Run both services on one server        | Follow the [Docker Compose](#docker) steps below                                                                         |
| Deploy frontend and backend separately | Complete [Server deployment](backend.md) or [Worker deployment](worker.md), then configure and build the static frontend |

Replace all example domains and `192.168.1.20` with your own addresses. Run commands from the repository root unless a step says otherwise.

This guide deploys the browser-based Web frontend. For desktop package configuration, builds, and installation, see [Tauri deployment](tauri.md).

## Prepare the environment and source {#requirements}

Install Git and obtain the complete source, including the backend:

```sh
git clone --recurse-submodules https://github.com/99percentpeople/weblink.git
cd weblink
```

If an existing checkout is missing the backend directories, run:

```sh
git submodule update --init --recursive
```

Building from source requires [Bun](https://bun.sh/), using the version specified by `packageManager` in the root `package.json`. For Docker deployment, install Docker Engine or Docker Desktop with Compose; Bun is not required on the host.

## Configure the frontend {#signaling-backend}

### Signaling address and environment variables {#websocket}

Start a Bun server or Cloudflare Worker using [Server deployment](backend.md) or [Worker deployment](worker.md), and obtain a WebSocket address that browsers can reach. Copy the frontend configuration template:

```sh
cp apps/web/.env.example apps/web/.env.local
```

Edit `apps/web/.env.local` to point to your backend:

```dotenv
VITE_WEBSOCKET_URL=wss://signal.example.com
WEBLINK_STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
```

| Setting                | Purpose                                                                                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `VITE_WEBSOCKET_URL`   | Signaling address used by browsers. Public HTTPS pages use `wss://`; LAN HTTP testing can use `ws://192.168.1.20:9000` |
| `WEBLINK_STUN_SERVERS` | Comma-separated STUN addresses; replace them with your own STUN service if needed                                      |
| `VITE_TURN_SERVERS`    | Optional custom TURN relays; see [STUN and TURN](#stun-and-turn) for the format                                        |

When serving other devices, do not use `localhost`, `127.0.0.1`, or the Docker service name `ws-server` as the signaling host. Browsers must reach this address from their own networks, and all members of a room must use the same signaling endpoint.

Frontend configuration is embedded in static files **at build time**. Rebuild and upload the output after changing it. The root `.env` configures combined local development and does not replace `apps/web/.env.local`. Docker builds exclude local env files; use the Compose build arguments below.

All frontend `VITE_*` / `WEBLINK_*` configuration can appear in public JavaScript. Configure Cloudflare TURN provider keys only on the backend.

A saved address in **Settings → Connection → WebSocket signaling server** overrides the deployment default. Use “Reset” to restore the default, then rejoin the room.

## Build and host static files {#static-hosting}

### Build and preview locally {#build-and-preview}

After configuring the frontend, install dependencies and build:

```sh
bun install --frozen-lockfile
bun run build
```

The output is written to `apps/web/dist/`. Preview the build locally:

```sh
bun run preview --host 127.0.0.1 --port 4173
```

Open `http://127.0.0.1:4173` and try joining a room. The preview command checks the build; use static hosting or a web server for a persistent deployment.

### Serve your own domain {#publish-static-files}

Upload **all files inside** `apps/web/dist/` to the static site's document root, including assets, icons, and the Service Worker. The current frontend builds for the domain root `/`, such as `https://web.example.com/`.

For a static hosting platform that builds from source, configure:

| Setting                     | Value                                                                                                    |
| --------------------------- | -------------------------------------------------------------------------------------------------------- |
| Project root                | Repository root                                                                                          |
| Install command             | `git submodule update --init --recursive`, then `bun install --frozen-lockfile`                          |
| Build command               | `bun run build`                                                                                          |
| Output directory            | `apps/web/dist`                                                                                          |
| Build environment variables | `VITE_WEBSOCKET_URL`, `WEBLINK_STUN_SERVERS`, and optional `VITE_TURN_SERVERS` from the previous section |

Set environment variables on the hosting platform for hosted builds. Your local `.env.local` is not uploaded with the source.

For your own Nginx server, place the output in `/var/www/weblink` and add this to the site's configuration:

```nginx
root /var/www/weblink;
index index.html;

location / {
    try_files $uri $uri/ /index.html;
}
```

Check the configuration and reload the running Nginx service:

```sh
sudo nginx -t
sudo systemctl reload nginx
```

Configure a valid HTTPS certificate for the public domain and use WSS for signaling. Browser features such as camera, microphone, screen sharing, clipboard, and PWA support generally require a secure context.

## Docker Compose: start both services {#docker}

This method builds the frontend Nginx image and the Bun signaling image. Prepare the source and submodules first, then update the root `docker-compose.yaml` to the following configuration, replacing the host IP:

```yaml
services:
  weblink:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        VITE_WEBSOCKET_URL: ws://192.168.1.20:8080/ws
        WEBLINK_STUN_SERVERS: stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
    ports:
      - "8080:80"
      - "443:443"
    environment:
      ENABLE_SSL: "false"
    volumes:
      - ./docker/ssl:/etc/nginx/ssl:ro
    depends_on:
      - ws-server
    restart: unless-stopped

  ws-server:
    build:
      context: ./servers/weblink-ws-server
    environment:
      HOSTNAME: 0.0.0.0
      PORT: "9000"
      NODE_ENV: production
      LOG_LEVEL: info
    ports:
      - "127.0.0.1:9000:9000"
    restart: unless-stopped
```

Start the services and check their status:

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 weblink ws-server
```

On another device, open `http://192.168.1.20:8080`. The browser connects through `/ws` on the same entry point, and Nginx forwards to `ws-server:9000` inside the container network. This example exposes backend port 9000 only on the host's loopback interface. Check it on the server:

```sh
curl http://127.0.0.1:9000/healthcheck
```

HTTP 200 means the backend has started. Run `docker compose up -d --build` again after changing Compose build arguments or the Nginx template. The frontend currently prefers the signaling address embedded at build time; changing container runtime environment variables alone does not override that value.

Stop the services:

```sh
docker compose down
```

### Enable HTTPS with the included Nginx image {#https-with-the-included-nginx-image}

1. Point your domain to the server and obtain a browser-trusted certificate matching that domain.
2. Save the certificate chain as `docker/ssl/server.crt` and its private key as `docker/ssl/server.pem`.
3. In the Compose configuration above, change `ENABLE_SSL` to the string `"true"` and `VITE_WEBSOCKET_URL` to `wss://web.example.com/ws`.
4. Allow clients to reach port 443 and run `docker compose up -d --build` again.
5. Open `https://web.example.com` and join the same room on two devices.

The template keeps the HTTP entry point when HTTPS is enabled and does not redirect automatically. If an existing reverse proxy handles HTTPS, keep HTTP inside the container and forward to port 8080. The proxy must support WebSocket upgrades, and the frontend build argument must still use the external WSS address.

## STUN and TURN {#stun-and-turn}

STUN helps devices discover usable network addresses. Connections across networks, restrictive NAT, or firewalls may also need a TURN relay. The signaling service itself does not relay files or media.

If you already have a TURN service, add it to `apps/web/.env.local`. For Docker, add the same variable to `weblink.build.args`:

```dotenv
VITE_TURN_SERVERS=turn:turn.example.com:3478|user|password|longterm
```

Each entry uses `url|username|password|authMethod`. Supported methods are `longterm` and `hmac`; separate multiple entries with actual newlines. The address, port, authentication method, and credentials must match your TURN service. These static credentials are delivered to browsers.

### Use Cloudflare TURN through the backend {#server-provided-cloudflare-turn}

After setting `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` as described in [Server TURN configuration](backend.md#turn) or [Worker TURN configuration](worker.md#turn), the frontend automatically requests temporary credentials from `/turn-credentials` on the signaling origin. For example, `wss://signal.example.com/ws` maps to `https://signal.example.com/turn-credentials`. No frontend provider key or separate credential API URL is required.

The included Nginx template only proxies `/ws` by default. To use this feature, also forward `/turn-credentials` as described in [reverse proxy configuration](backend.md#tls-and-proxy). Do not use the removed `|cloudflare` format in `VITE_TURN_SERVERS`.

## LAN use {#lan-deployment}

The Docker HTTP example above can test connectivity on a LAN. For separate services, bind the Bun backend to `0.0.0.0:9000`, set the frontend address to `ws://192.168.1.20:9000`, and allow clients to reach the required ports.

To temporarily run the frontend from source, install dependencies, configure `.env.local`, and run:

```sh
bun run dev:web --host 0.0.0.0
```

Other devices can open the LAN address printed in the terminal; the default port is 5173. Restart the development server after changing env files. For testing entirely on one machine, both frontend and backend addresses can use `127.0.0.1`.

Browsers may restrict media and clipboard features on LAN HTTP pages. For full functionality, configure HTTPS/WSS with certificates trusted by the devices, even on a LAN.

## Verify the deployment {#production-checklist}

Open the deployed site on two devices using the same signaling address, room ID, and password. Check member discovery, messaging, file transfer, and rejoining after a disconnect. Test TURN on networks that require relaying; a successful health check only confirms that the signaling process is available.

## Choose your next step {#next-steps}

- **Also provide a desktop client with your defaults:** follow [Tauri deployment](tauri.md).
- **Run the signaling backend on your own server:** continue with [Server deployment](backend.md).
- **Use Cloudflare to host the signaling backend:** continue with [Worker deployment](worker.md).
- **The website is live but signaling cannot connect:** follow the [WebSocket troubleshooting steps](../guide/faq.md#signaling-unreachable).
