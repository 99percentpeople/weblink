# Testing

Weblink separates correctness tests by **test boundary**, not by implementation
feature. The goal is to keep fast deterministic feedback separate from real-browser
smoke coverage and from performance measurements.

Visual appearance is reviewed manually. Keep new UI tests focused on behavior,
permissions, state transitions and resource cleanup. Avoid new screenshot or
CSS geometry assertions for routine layout and styling changes.

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
- chat scrollports, layout-driven bottom following and reading anchors

They are **smoke tests**, not the primary exhaustive regression suite. Each one
covers a high-value end-to-end subsystem path with a small number of scenarios.

Commands:

```sh
bun run test:e2e:protocol
bun run test:e2e:recovery
bun run test:e2e:playback
bun run test:e2e:transfer
bun run test:e2e:cache
bun run test:e2e:tasks
bun run test:e2e:chat
bun run test:e2e:conversations
bun run test:e2e:meeting
bun run test:e2e:speed
```

`test:e2e:recovery` uses Node 22+ and Chromium to exercise interrupted initial
negotiation, repeated simultaneous peer recovery, forced colliding SDP offers,
and camera/screen/audio RTP after reconnect. Signaling outages are controlled
in-process; SDP, ICE, decoded video frames, audio packets and data channels are
real browser transports. It also verifies that leaving/rejoining reuses local
capture without reopening a stopped camera.

`test:e2e:playback` uses Node 22+ and Chromium with the actual video component
and received RTP. It checks deferred source attachment, interrupted playback,
visibility/presentation recovery and borrowed-track cleanup. Native PiP return
events are simulated; it does not establish iPhone Safari rendering correctness.

`test:e2e:protocol` also covers three independent room-chat protocol instances
over real unordered mesh DataChannels, including partial delivery, connection
replacement and idempotent retry. It also checks simultaneous synthetic video
sources, microphone audio and shared audio over real RTP connections, then removes
individual sources without interrupting retained tracks. It does not simulate
physical devices or NAT.

`test:e2e:transfer` covers concurrent private transfers and partial-download
resume, then exercises three room-file service instances over real unordered
control DataChannels. Offers must create neither receiver caches nor binary
channels before an explicit download. Two recipients download independently and
compare their complete files byte-for-byte using SHA-256. The provider's room
cache must survive the first download even with automatic cache deletion enabled;
legacy private request/resume messages must not bypass room authorization. The
check also verifies separate download request IDs, per-recipient transfer state
and absence of private-history projections. File caches use real, separately
namespaced IndexedDB databases and real compression/decompression Workers.
This fixture keeps message histories in memory and does not render the download
button: UI interaction and durable message-store reloads have separate tests.
The same transfer smoke covers shared-directory pulls between two peers, local
content reuse without binary channels, pause/resume with byte comparison,
cancellation that closes both peers' active channels and allows a new download,
permission revocation, forged IDs, legacy request denial and absence of new chat
messages. Sidebar integration tests cover member selection, 50-item pagination,
search/sort, multi-select fetching, refresh retention, task cancellation,
visibility cleanup and late responses.
The room transfer fixture uses application-default transfer settings and
negotiates a 32 KiB SCTP message limit. The complete binary packet, including its
seven-byte header, must fit that budget; both manual recipients must receive
byte-identical files without closing the chat channel.

`test:e2e:conversations` uses real IndexedDB to check the v1-to-v2 migration,
conversation isolation, persisted labels/read cursors, interrupted delivery
recovery and deletion. `test:e2e:meeting` renders the actual meeting and chat UI,
with a local message repository and synthetic media tracks; external signaling
and network message delivery are replaced in that UI check. It uses the app's
height constraints and long room/private histories to check internal scrolling,
viewport overflow and the fixed position of the bottom controls.
The meeting conversation list lives in the right panel's Conversations tab;
selecting private or room history switches to Chat without replacing the stage
or leaving the meeting. Checks cover four-tab keyboard navigation, combined
search/label filtering, grouping and narrow-screen panel containment.
Room dialog checks open settings from the group header, verify that capability
notices are absent from the composer, and select devices without starting
capture, including while a camera, muted microphone and shared screens are live.
Settings contain no capture switches and preserve existing track identities and
enabled states. The toolbar must reflect those preferences after closing the
dialog. Media-controller tests verify applying a preference on the next activation,
retrying a failed activation and discarding stale pending capture results.
Device-access checks open the device tab directly from the right header, distinguish
missing permission from blocked or absent devices, and refresh after permission
changes. Granting access stops temporary tracks and never publishes them or touches
existing meeting media. Tests cover native speaker selection, the microphone-based
fallback, unsupported permission queries, dismissed prompts and late capture after
disposal. Browser checks use deterministic permission APIs and synthetic media;
they validate application behavior rather than a browser's native permission UI.
Historical-room settings cannot edit the current meeting. Device APIs still use
fixtures and synthetic tracks; these checks do not validate physical hardware.
Room media checks render a sender's local image immediately, leave incoming
images as metadata until requested, then verify the received image loads.
Private and room views open and close real PhotoSwipe galleries and verify the
active attachment's download link. Media checks compare thumbnail pixel geometry
with PhotoSwipe transition bounds, verify hash updates and Back/Forward behavior,
and mount an older-history deep link before local cache hydration. Room checks
also decode a generated WebM video inside PhotoSwipe and WAV audio in native controls. File-card component tests
cover the shared MIME-specific presentation, object-URL cleanup, circular progress,
pause/resume dispatch for both conversation types and per-recipient room state,
without issuing implicit transfers. The sender's details dialog keeps large recipient
lists internally scrollable and updates progress while open without expanding its
message bubble or initiating a transfer. Browser checks also compare the file-card
height before, during and after a transfer to catch extra speed rows.
Focus-layout checks cover a short viewport and many thumbnails; only the
thumbnail rail scrolls. All grid, focused and thumbnail frames must retain 16:9
geometry. Grid checks repeatedly resize the stage's container (without a window
resize), add/remove sources, and restore side panels; tiles must stay inside the
available width and height and column sizes must settle without observer loops.
Unit checks cover column-boundary jitter, coalescing resize bursts, one observer
per grid, hidden-container recovery and cancellation during unmount.
The right header's sharing status and stop action must fit narrow
viewports, including a long presenter name. Media controls use a camera and two shared
screens, including stopping the pinned source and retaining the other captures.
Screen-picker checks require optional audio to be requested and published alongside
each screen, independently of microphone mute/device changes. Stopping one or all
screens must release the corresponding audio. Unit checks also cover the browser's
native stop event, audio-only termination, capture without audio, invalid capture
cleanup and late permission results. The picker itself uses synthetic tracks in
automation; these checks do not validate native chooser options or OS audio capture.
Device-selection checks use enumerated fixture devices and capture/output API
stubs to verify selections, constraints, independent tracks and narrow layouts.
Unit checks cover device replacement failures, mute preservation, late capture
results and output routing; physical device switching still requires a live check.

Use `MEETING_TEST_WIDTH=390 bun run test:e2e:meeting` for the narrow layout,
and set `MEETING_TEST_SCREENSHOT=/tmp/meeting.png` to capture the final screen.

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
CHAT_TEST_WIDTH=390 bun run test:e2e:chat
CHAT_TEST_REDUCED_MOTION=1 bun run test:e2e:chat
CHAT_TEST_SCREENSHOT=/tmp/chat.png bun run test:e2e:chat
CHAT_TEST_COLOR_SCHEME=dark CHAT_TEST_WIDTH=390 CHAT_TEST_SCREENSHOT=/tmp/chat-dark.png bun run test:e2e:chat
TASK_TEST_WIDTH=390 bun run test:e2e:tasks
TASK_TEST_SCREENSHOT=/tmp/tasks.png bun run test:e2e:tasks
TASK_TEST_SCREENSHOT_INFO=/tmp/client-info.png bun run test:e2e:tasks
SPEED_TEST_REPORT=/tmp/speed-report.json bun run test:e2e:speed
```

The chat smoke checks sample actual intermediate scroll positions, not only the
final offset. They cover initial positioning, batch arrivals, layout changes during
native smooth scrolling, reader interruption and reduced-motion preferences. They
also verify compact consecutive bubbles, time-gap separators, and stable message
nodes when a group grows or its first message is deleted. The
optional screenshot mode uses an isolated conversation with text, files and both
incoming/outgoing bubbles; it does not use a real conversation's data.

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
