# Worker deployment

Deploy signaling to your own Cloudflare Workers account, with Durable Objects managing rooms. Web and Tauri clients connect to the deployed WSS address. You do not need a separate Bun Server, Redis, or a persistent host process.

Worker and [Server](backend.md) are alternative backends; all devices in a room must use the same signaling address. Worker handles signaling, while messages, files, and media use WebRTC, with TURN when relaying is needed.

You can connect from the existing website or desktop app by changing its WS address; no frontend deployment is required. See the [self-hosting overview](overview.md#signaling-only).

## Prepare the environment and source {#prepare}

Install Git and [Bun](https://bun.sh/), using the version in the root `package.json` `packageManager` field. Get the complete source and install dependencies:

```sh
git clone --recurse-submodules https://github.com/99percentpeople/weblink.git
cd weblink
bun install --frozen-lockfile
```

For an existing checkout, run `git submodule update --init --recursive` from the repository root before installing dependencies. The steps below start from that root.

You also need your own Cloudflare account with access to Workers and Durable Objects. Use a Workers.dev address initially, or a custom domain managed by that account.

## Configure and deploy the Worker {#cloudflare-worker}

### Configure your Worker {#worker-configuration}

Edit `servers/weblink-ws-worker/wrangler.jsonc`. For the first deployment, you can use a Workers.dev address without optional managed TURN:

| Field              | Setting                                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `name`             | Choose a name in your account, such as `my-weblink-signaling`                                                          |
| `workers_dev`      | Keep `true` and use the Workers.dev address printed by deployment                                                      |
| `routes`           | Set to `[]` to remove the repository's project domain, `ws.webl.ink`                                                   |
| `secrets.required` | Initially set to `[]`. The template's two required Secrets belong to optional TURN support and can be configured later |

Keep the remaining configuration, especially the `ROOMS` binding, `SignalingRoom` export, and SQLite storage settings. Keep `WS_CONNECT_LIMITER` and ensure its `namespace_id` is unique within your account.

For a custom domain, set `routes` to a domain managed by your Cloudflare account:

```json
[
  {
    "pattern": "signal.example.com",
    "custom_domain": true
  }
]
```

This array replaces only the value of `routes`, not the whole configuration file.

### Log in and deploy {#worker-deploy}

From the repository root, enter the Worker directory, log into your account, and deploy:

```sh
cd servers/weblink-ws-worker
bunx wrangler login --device
bun run deploy
```

Complete account authorization as prompted. After deployment, copy the printed HTTPS address, replace the example domain below, and check it:

```sh
curl https://my-weblink-signaling.example.workers.dev/healthcheck
```

After HTTP 200, configure the frontend with `wss://my-weblink-signaling.example.workers.dev`. For a custom domain, use `wss://signal.example.com` instead.

The Worker does not require you to maintain a persistent process. After changing Worker configuration, run `bun run deploy` again from the same directory.

## Optional: configure Cloudflare TURN {#turn}

If client networks need relaying, use your own TURN service or let the signaling backend provide temporary Cloudflare TURN credentials. See the [STUN/TURN overview](overview.md#stun-and-turn) for service choices and client configuration; a frontend build is optional.

For managed TURN, prepare a Cloudflare TURN Key ID and API token, and configure them only on the backend. Signaling still works without managed TURN.

### Set production secrets {#turn-worker}

After the initial deployment above, enter the Worker directory from the repository root and supply each value when prompted:

```sh
cd servers/weblink-ws-worker
bunx wrangler secret put TURN_KEY_ID
bunx wrangler secret put TURN_KEY_API_TOKEN
bun run deploy
```

Once configured, you can restore `secrets.required` to `["TURN_KEY_ID", "TURN_KEY_API_TOKEN"]` so later deployments check that they exist. Local Worker development uses `.dev.vars`; that file does not automatically configure production Secrets.

See [Cloudflare Secrets documentation](https://developers.cloudflare.com/workers/configuration/secrets/) for secret management options.

### Check the credential endpoint {#turn-verify}

Replace the URL with your Worker domain. The credential endpoint is at its root path:

```sh
curl -i -X POST https://signal.example.com/turn-credentials
```

Success returns JSON containing `iceServers` and `expiresAt`, with temporary credentials valid for 24 hours. The frontend requests and refreshes credentials as needed without a separate API URL setting.

This endpoint is public, and WebSocket admission limits do not cover it. If you need request limits, configure separate rules for this HTTP path at the entry point. Any access rules or additional proxies must allow `POST` and `OPTIONS` and preserve CORS and no-cache response headers.

## Connect clients and verify {#verify}

1. Access the corresponding `/healthcheck` from a client network to confirm the domain, certificate, and port are reachable.
2. Open the existing Weblink website or desktop app and [set its signaling address](overview.md#signaling-only). Use your own frontend or desktop package if you have deployed one.
3. On two devices, check that **Settings → Connection** does not override the address with an old server, then join with the same room ID and password.
4. Verify member discovery, messaging, file transfer, and rejoining after a disconnect. Also test relaying on networks that need TURN.

## Choose your next step {#troubleshooting}

- **Connect the existing website to your Worker:** follow [client connection settings](overview.md#signaling-only).
- **Connect desktop clients or package your defaults:** follow [Tauri deployment](tauri.md).
- **Clients in mainland China have trouble reaching the Worker:** follow the [signaling reachability checks](../guide/faq.md#signaling-mainland).
- **Investigate an error from the TURN credential endpoint:** use the [TURN credential FAQ](../guide/faq.md#turn-credentials).
