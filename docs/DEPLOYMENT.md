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

### Cloudflare Pages releases from Git tags

The [CI workflow](../.github/workflows/ci.yml) is the single gate for both
development and production publishing. Stable tags such as `v1.0.0` run the same
`Checks` job as branch pushes: release metadata validation, type-checking, unit
tests and integration tests. Only after `Checks` succeeds does the
`deploy-production` job build the production bundle and upload `dist/`.
Prerelease tags such as `v1.1.0-beta.1` do not match the workflow trigger and
therefore do not publish to production.

Tests are not repeated in the deployment job. Production deployments are
serialized, while a failed `Checks` job prevents the build and upload entirely.
Bun, Node's major version, and Wrangler are explicitly selected; application
dependencies use the frozen lockfile.

The workflow reads the existing project's `production_branch` through the
Cloudflare API and supplies it to `wrangler pages deploy --branch`. This preserves
the production domain even though the source checkout is a tag, and avoids
mistaking the tag name for a preview branch. The deployed commit hash and message
identify the release.

#### One-time setup

1. Keep the existing `weblink` Pages project and its custom domains. For a
   Git-integrated project, open its branch deployment controls and disable
   **automatic production branch deployments**. Set preview branch deployments
   to **None** if all deployments should happen only through release tags.
2. Create a Cloudflare API token scoped to the project's account with
   **Account → Cloudflare Pages → Edit** permission.
3. Configure the following GitHub Actions secrets, either on the repository or
   in its `production` environment:

   | Secret                  | Value                                                          |
   | ----------------------- | -------------------------------------------------------------- |
   | `CLOUDFLARE_ACCOUNT_ID` | Account ID containing the existing Pages project               |
   | `CLOUDFLARE_API_TOKEN`  | Pages API token                                                |
   | `PAGES_BUILD_ENV`       | Complete production `VITE_*` settings in multiline dotenv form |

   A minimal `PAGES_BUILD_ENV` value is:

   ```dotenv
   VITE_BACKEND=WEBSOCKET
   VITE_WEBSOCKET_URL=wss://ws.webl.ink
   ```

   Copy any existing production STUN, TURN, or Firebase settings into the same
   value. Preserve the variable names documented above. The workflow writes this
   secret into the ignored `.env.production.local` file before building. The
   build runs on GitHub, so variables configured only in the Pages build settings
   are not supplied to it. `VITE_*` values become part of the public frontend;
   keep the deployment API token in its separate secret.

4. If the GitHub `production` environment restricts allowed deployment refs,
   permit the release tags. Keep any existing approval policy for that environment.

Cloudflare supports Wrangler uploads to an existing Git-integrated Pages project
after automatic deployments are disabled; recreating the project is unnecessary.
See [Git integration controls](https://developers.cloudflare.com/pages/configuration/git-integration/)
and [Direct Upload from CI](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/).

#### Publish a release

Commit the version bump and changelog, and ensure the release commit includes the
Pages workflow. After completing the setup above:

```sh
git push origin public
git tag -a v1.0.0 -m "Weblink 1.0.0"
git push origin v1.0.0
```

For subsequent releases, replace `v1.0.0` with the matching version. Inspect the
tag-triggered **CI** Actions run and its **Deploy production release** job before
treating the release as deployed. A failed `Checks` job prevents the production
build and upload. A failed deployment can be retried through the existing Actions
run; do not move a published tag to another commit. To roll back, select a
previous successful production deployment in the Pages dashboard.

### Continuous development channel

`https://dev.webl.ink` follows the latest successful push to `public`. The
[CI workflow](../.github/workflows/ci.yml) first runs only the shared validation
gate: type-checking, unit tests and integration tests. After `Checks` succeeds,
the dependent `deploy-dev` job builds and uploads the development bundle. Tests
are not repeated, and CI no longer builds a throwaway production bundle before
the dev build. Pull requests, other branches and release tags cannot publish to
this hostname. Local commits take effect only after a push; when several commits
are pushed together, the branch tip is built. New pushes cancel superseded CI
runs.

The development job uploads to the fixed **`dev` preview branch** of the
existing `weblink` Pages project. The production deployment job and domains
remain isolated from this preview branch.

#### Build identity and debugging

```sh
bun run build:dev
```

This runs `vite build --mode dev`, not a publicly exposed Vite development
server. It retains optimized production runtime code and PWA support, but keeps
debug logs. The displayed version becomes `1.0.4-dev.<short-commit>` (using the
current package version); `package.json` itself is not rewritten. The document
and installed PWA are named **Weblink Dev**. Dev builds include robots exclusions
and an `X-Robots-Tag` header to discourage search indexing; this is not access
control.

Every build exposes `/version.json` containing its channel, full commit hash,
version and build timestamp, with `Cache-Control: no-store`. After uploading the
`dev` branch, CI polls `dev.webl.ink/version.json` and succeeds only when the
custom domain serves the tested commit. Browser application data and PWA
installations belong to the separate hostname; signaling and ICE settings can
still be shared with the stable site.

#### Preview environment

The GitHub **Preview** environment uses the repository's existing
`CLOUDFLARE_API_TOKEN` secret (Pages Edit). No account lookup or DNS permission
is needed for ordinary preview uploads.

Committed `.env.dev` provides public WebSocket and STUN defaults. Optional
`PAGES_BUILD_ENV` in Preview supplies additional `VITE_*` settings and is written
to ignored `.env.dev.local` before building.

Production environment secrets are not automatically available in Preview.
Keep any TURN/Firebase settings that the development frontend needs in its own
`PAGES_BUILD_ENV`. These `VITE_*` values are public frontend configuration, not
deployment credentials. Regular deployments need no DNS-edit permission.

#### Development custom domain

`dev.webl.ink` is configured manually in Cloudflare and is not modified by CI.
It must be attached to the existing `weblink` Pages project and its **proxied**
CNAME must target `dev.weblink-main.pages.dev`. Cloudflare requires proxying for
[custom branch aliases](https://developers.cloudflare.com/pages/how-to/custom-branch-aliases/);
an unproxied or production-alias target can serve the wrong deployment. Do not
point it to `weblink-main.pages.dev`.

Each successful `public` deployment updates the Pages `dev` branch first, then
verifies that `dev.webl.ink` serves the same commit. CI never changes DNS
records.

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
