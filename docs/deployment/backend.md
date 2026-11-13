# Server deployment

Run the Bun signaling service on your own server or LAN host to let Web and Tauri clients join rooms, discover members, and negotiate WebRTC connections. Chat, files, and media use WebRTC; TURN carries traffic when a relay is needed.

A single Server instance does not need Redis. For a Cloudflare-hosted backend, use [Worker deployment](worker.md) instead. Choose one backend and connect all devices in a room to the same signaling address.

After deployment, you can keep using the existing website or desktop app and change its WebSocket address in settings. The [self-hosting overview](overview.md#signaling-only) explains this setup without a frontend deployment. Replace example domains and IPs with your own addresses.

## Prepare the environment and source {#prepare}

Install Git and [Bun](https://bun.sh/), using the version in the root `package.json` `packageManager` field. Get the complete source and install dependencies:

```sh
git clone --recurse-submodules https://github.com/99percentpeople/weblink.git
cd weblink
bun install --frozen-lockfile
```

For an existing checkout, run `git submodule update --init --recursive` from the repository root before installing dependencies. The steps below start from that root.

Docker does not require Bun on the host. Use the [complete Compose example in Web deployment](hosting.md#docker) to start Web and Server together. The steps below run Server directly as a process.

## Bun signaling server {#bun-server}

### Configure the listening address and port {#bun-configuration}

Enter the backend directory and copy the configuration template:

```sh
cd servers/weblink-ws-server
cp .env.example .env.local
```

Edit `servers/weblink-ws-server/.env.local`. Use this minimal single-instance configuration, clearing the two TURN placeholder values in the template when managed TURN is not enabled:

```dotenv
HOSTNAME=0.0.0.0
PORT=9000
NODE_ENV=production
LOG_LEVEL=info
REDIS_URL=
TURN_KEY_ID=
TURN_KEY_API_TOKEN=
```

| Setting                              | Description                                                                                                                                    |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `HOSTNAME`                           | Listening interface. `0.0.0.0` accepts connections from other devices; use `127.0.0.1` when only a reverse proxy on the same host needs access |
| `PORT`                               | Shared port for signaling and HTTP health checks; defaults to 9000                                                                             |
| `NODE_ENV` / `LOG_LEVEL`             | Use `production` and `info` for normal deployment                                                                                              |
| `REDIS_URL`                          | Leave empty for a single instance. Set a Redis connection URL for coordination across instances                                                |
| `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` | Optional Cloudflare TURN settings; see [below](#turn)                                                                                          |

Bun reads `.env.local` from the current backend directory. You can also supply configuration through process or container environment variables. Do not put backend settings in `apps/web/.env.local`.

### Start and check the service {#bun-start}

Remain in `servers/weblink-ws-server` and run:

```sh
bun run start
```

The process runs in the foreground and prints logs in the terminal; press Ctrl+C to stop it. Check it in another terminal on the same host:

```sh
curl http://127.0.0.1:9000/healthcheck
```

HTTP 200 means the service has started. If the server's LAN address is `192.168.1.20`, allow clients to reach TCP port 9000 and use `ws://192.168.1.20:9000` from an HTTP frontend. HTTPS frontends require WSS; follow [reverse proxy and TLS](#tls-and-proxy).

Restart the process after changing env settings. For persistent operation, use your process manager or the [Docker Compose example](hosting.md#docker), which runs in the background with `restart: unless-stopped`.

When using multiple Bun instances, consistently route each room to the same instance. Redis can coordinate instances, but configuring it alone does not share complete room verification and recovery state. A typical self-hosted installation can keep a single instance.

## Reverse proxy and TLS {#tls-and-proxy}

HTTPS pages and packaged desktop clients using non-loopback hosts should connect through `wss://` signaling. Use Nginx to handle TLS for Server, or load certificates directly in Bun.

### Proxy Nginx to Bun {#nginx-proxy}

This example runs Nginx and Bun on the same host. Point the domain to the server and obtain a valid certificate and private key matching the domain. Change Bun's `HOSTNAME` to `127.0.0.1`, add `TRUSTED_PROXY_IPS=127.0.0.1`, and restart the backend.

Add this `server` block in Nginx's site configuration directory, replacing the domain and certificate paths:

```nginx
server {
    listen 443 ssl;
    server_name signal.example.com;

    ssl_certificate /etc/nginx/certs/signal.example.com.crt;
    ssl_certificate_key /etc/nginx/certs/signal.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 90s;
    }
}
```

This forwards WebSocket traffic, `/healthcheck`, and `POST` / `OPTIONS /turn-credentials`. Allow external access to port 443, check the configuration, and reload the running Nginx service:

```sh
sudo nginx -t
sudo systemctl reload nginx
curl https://signal.example.com/healthcheck
```

Use `wss://signal.example.com` in the frontend. `TRUSTED_PROXY_IPS` must contain only trusted proxies that connect directly to Bun, and the proxy must overwrite `X-Real-IP`. If Nginx runs on another host or in a container, use the reachable backend address and actual proxy TCP address instead.

The included `docker/nginx.conf.template` only forwards `/ws` by default. To enable managed TURN or check health through the website entry point in Docker, add these locations inside the same `server`:

```nginx
location = /turn-credentials {
    proxy_pass http://ws-server:9000;
}

location = /healthcheck {
    proxy_pass http://ws-server:9000;
}
```

After changing the template, run `docker compose up -d --build`. To apply limits per client IP, also overwrite `X-Real-IP` in the template's `/ws` proxy and set the proxy's actual TCP address in Bun's `TRUSTED_PROXY_IPS`; otherwise, clients behind the proxy share a limit.

### Enable TLS directly in Bun {#bun-tls}

Without a reverse proxy, set absolute certificate and private key paths in the backend `.env.local`:

```dotenv
TLS_CERT_FILE=/path/to/server.crt
TLS_KEY_FILE=/path/to/server.key
```

Keep `HOSTNAME=0.0.0.0`, restart Bun, and allow clients to reach the listening port. If using port 9000, check `https://signal.example.com:9000/healthcheck` and configure the frontend with `wss://signal.example.com:9000`. Optional `TLS_CA_FILES` accepts comma-separated CA file paths.

## Optional: configure Cloudflare TURN {#turn}

If client networks need relaying, use your own TURN service or let the signaling backend provide temporary Cloudflare TURN credentials. See the [STUN/TURN overview](overview.md#stun-and-turn) for service choices and client configuration; a frontend build is optional.

For managed TURN, prepare a Cloudflare TURN Key ID and API token, and configure them only on the backend. Signaling still works without managed TURN.

### Bun or Docker {#turn-bun}

Set the actual values in the Bun backend's `.env.local` and restart:

```dotenv
TURN_KEY_ID=your-turn-key-id
TURN_KEY_API_TOKEN=your-turn-key-api-token
```

For Compose, add these variables to **`ws-server.environment`**, then run `docker compose up -d ws-server` to apply them. They belong to the backend runtime environment, not the frontend `build.args`.

### Check the credential endpoint {#turn-verify}

Replace the URL with your signaling origin. When using the Docker `/ws` entry point, the credential endpoint is still at the root path:

```sh
curl -i -X POST https://signal.example.com/turn-credentials
```

Success returns JSON containing `iceServers` and `expiresAt`, with temporary credentials valid for 24 hours. The frontend requests and refreshes credentials as needed without a separate API URL setting.

This endpoint is public, and WebSocket admission limits do not cover it. If you need request limits, configure separate rules for this HTTP path at the entry point. The reverse proxy should allow `POST` and `OPTIONS` and preserve CORS and no-cache response headers.

## Connect clients and verify {#verify}

1. Access the corresponding `/healthcheck` from a client network to confirm the domain, certificate, and port are reachable.
2. Open the existing Weblink website or desktop app and [set its signaling address](overview.md#signaling-only). Use your own frontend or desktop package if you have deployed one.
3. On two devices, check that **Settings → Connection** does not override the address with an old server, then join with the same room ID and password.
4. Verify member discovery, messaging, file transfer, and rejoining after a disconnect. Also test relaying on networks that need TURN.

## Choose your next step {#next-steps}

- **Use this backend from the existing website:** follow [client connection settings](overview.md#signaling-only).
- **Connect an existing desktop client to this service:** follow [desktop package setup](tauri.md#existing-package).
- **Move signaling to Cloudflare hosting:** follow [Worker deployment](worker.md).
- **HTTP health checks pass but clients cannot connect:** follow the [WebSocket troubleshooting steps](../guide/faq.md#signaling-unreachable).
- **Investigate a failed TURN credential request:** check the [TURN response explanations](../guide/faq.md#turn-credentials).
