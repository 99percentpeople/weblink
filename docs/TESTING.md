# Testing

Weblink separates correctness tests by **test boundary**, not by implementation
feature. The goal is to keep fast deterministic feedback separate from real-browser
smoke coverage and from performance measurements.

## Test layers

### Unit tests

Location: `test/unit/`

Unit tests exercise one module or one small contract in isolation. They should
prefer plain values, fakes and injected dependencies over browser/network
orchestration.

Typical subjects:

- protocol parsers and codecs
- pure projections and utilities
- isolated domain controllers
- individual application services with injected fakes
- local stream and ICE diagnostic policy
- binary packet layout and validation

Run:

```sh
bun run test:unit
```

A unit test should not require a real `RTCPeerConnection`, IndexedDB transaction,
module Worker or rendered multi-component application flow.

### Integration tests

Location: `test/integration/`

Integration tests exercise multiple Weblink modules together. They may use jsdom,
Solid rendering, fake RTC transports/channels, reactive stores or in-memory
repositories, but remain deterministic and process-local.

Typical subjects:

- room/session lifecycle ownership
- typed P2P request/reply flows
- messaging + message-store integration
- file-transfer service + registry behavior
- task state derived from messages/transfers
- rendered dialogs/settings/components
- signaling client lifecycle with fake WebSockets
- speed-test service behavior over paired fake channels

Run:

```sh
bun run test:integration
```

Shared test fakes live in `test/support/`.

The default correctness suite runs both unit and integration tests:

```sh
bun run test
```

CI runs unit and integration as separate steps so a failure clearly identifies
the affected boundary.

### Browser E2E smoke tests

Location: `test/e2e/smoke/`

These checks launch a disposable headless Chromium profile through CDP and a local
Vite server. They exercise real browser primitives that jsdom/fakes cannot prove:

- actual `RTCPeerConnection` and `RTCDataChannel`
- real IndexedDB
- real module Workers
- compression/decompression workers
- rendered task/diagnostic UI in Chromium

They are **smoke tests**, not the primary exhaustive regression suite. Each one
covers a high-value end-to-end subsystem path with a small number of scenarios.

Commands:

```sh
bun run test:e2e:protocol
bun run test:e2e:transfer
bun run test:e2e:cache
bun run test:e2e:tasks
bun run test:e2e:speed
```

Run all browser smoke checks sequentially:

```sh
bun run test:e2e
```

Requirements:

- Chromium available as `chromium`, or
- `CHROMIUM_PATH=/absolute/path/to/chromium`

The runner uses an isolated temporary profile, loopback peers and a local Vite
server. It does not join the deployed Weblink signaling service or mutate a real
browser profile.

Useful optional environment variables:

```sh
TASK_TEST_WIDTH=390 bun run test:e2e:tasks
TASK_TEST_SCREENSHOT=/tmp/tasks.png bun run test:e2e:tasks
TASK_TEST_SCREENSHOT_INFO=/tmp/client-info.png bun run test:e2e:tasks
SPEED_TEST_REPORT=/tmp/speed-report.json bun run test:e2e:speed
```

Because these are local subsystem E2E checks, passing them does not prove
cross-device, public-network, carrier, background-tab or production-deployment
behavior.

### Browser benchmarks

Location: `test/e2e/benchmark/`

Benchmarks measure performance and must not be treated as pass/fail correctness
coverage or run as part of the normal CI test suite.

Run the cache benchmark:

```sh
bun run bench:browser:cache
bun run bench:browser:cache --repeating
```

The benchmark uses real Chromium and IndexedDB but deliberately excludes WebRTC.
See [CACHE_ASSEMBLY.md](CACHE_ASSEMBLY.md) for the measured operation and historical
results.

## Directory layout

```text
test/
├── unit/                 # isolated module/contract behavior
├── integration/          # multiple Weblink modules together
├── support/              # shared fakes/helpers
└── e2e/
    ├── smoke/            # real Chromium correctness smoke tests
    └── benchmark/        # performance measurements only
```

Browser harness implementation is shared by
`scripts/run-browser-check.mjs`.

## What belongs where

Use the narrowest boundary that proves the behavior:

- A parser rejects malformed JSON → **unit**.
- `P2PProtocol` resolves a request through a fake transport → **integration**.
- A dialog reacts to application state in jsdom → **integration**.
- A real DataChannel sends queued protocol traffic in Chromium → **E2E smoke**.
- Real IndexedDB + module Worker finalizes a cached file → **E2E smoke**.
- Timing 128 MiB cache finalization → **benchmark**.

Do not promote every regression to E2E. Prefer unit/integration coverage first,
then add one browser smoke path when the behavior depends on a real browser
primitive or WebRTC/IndexedDB/Worker interoperability.

## Signaling backend tests

The two WebSocket signaling backends live in separate repositories and have their
own integration suites:

- `weblink-ws-server`: Bun tests + real local WebSocket server integration.
- `weblink-ws-worker`: Vitest with the Cloudflare Workers/Durable Object test
  environment.

Those tests validate signaling ownership, reconnect/cache behavior and backend
limits. They are not part of this frontend repository's browser E2E suite.

A future shared signaling contract fixture should be distributed through a
CI-consumable package/spec source rather than depending on sibling checkout
paths.

## Recommended validation before commit

For ordinary frontend changes:

```sh
bun run lint
bun run test:unit
bun run test:integration
bun run build
```

Add the relevant browser E2E smoke command when the change touches real WebRTC,
IndexedDB, Workers or browser-only UI behavior.

Protocol or transfer changes should run their focused E2E smoke check before
merge. Benchmarks are only required when making or validating performance claims.
