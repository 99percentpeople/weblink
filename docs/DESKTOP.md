# Desktop development

The Tauri 2 application in `apps/desktop` embeds the existing SolidJS application
from `apps/web`. The first target is Windows 10 22H2 / Windows 11 on x64, with
WebView2 120 or newer. The NSIS installer installs or updates the Evergreen
WebView2 runtime when needed. The desktop application has been manually run and
verified on Windows. Installer and feature-specific acceptance checks are listed
below; Linux compilation is a separate development check.
The current Linux host can launch the shell and exercise IPC, but its WebKit
does not expose `RTCPeerConnection`; the app therefore displays the existing
unsupported-browser page. Linux WebRTC support remains a separate platform task.

## Run and build

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/): on
Windows these include the MSVC 14.44 (Visual Studio 2022 17.14) or newer, Windows SDK 10.0.26100 or newer, Rust and WebView2. Native WebRTC downloads its prebuilt library on the first Cargo build. The root Cargo configuration selects the static MSVC runtime required by that library.
The repository pins Rust in `rust-toolchain.toml` and Bun in `package.json`.
Cargo also fetches the patched WebRTC bindings from the
[Weblink fork](https://github.com/99percentpeople/rust-sdks/tree/weblink-native-media),
pinned to a full Git revision in root `Cargo.toml` and `Cargo.lock`.
No vendored source or separate dependency preparation step is needed.
After initializing Git submodules, run from the root:

```sh
bun install
cp .env.example .env
bun run dev:desktop
```

`dev:desktop` starts the local Bun signaling server and Tauri. Tauri starts its
own Vite server at `http://127.0.0.1:1420`; the browser Vite server keeps port 5173. Root `.env` configures the signaling address just as it does for `bun dev`.
If signaling is already running, use `bun --env-file=.env run desktop`.

```sh
bun run check:desktop
bun run --cwd apps/desktop test
cargo test --workspace --locked
bun run build:desktop --bundles nsis
```

Run the NSIS command on Windows. For a host-only build without installers use
`bun run build:desktop --no-bundle`. Desktop frontend files go to
`apps/desktop/dist`; Rust binaries and installers go to root `target/`.
CI runs shared web/desktop TypeScript checks and tests once. `desktop-dev.yml`
then runs Rust tests and a `--no-bundle` build in the same release profile and
with the same `tauri/custom-protocol` feature. Both desktop workflows build the
frontend before Rust tests; `tauri.ci.conf.json` skips rebuilding it during
packaging. Normal local builds retain their frontend build hook. Dev CI disables
LTO and uses 16 codegen units to reduce compilation and cache overhead.
Its `weblink-windows-x64` artifact contains `weblink-desktop.exe`; the target
machine needs WebView2 installed. Only `public` builds save this dependency cache.

Stable `vX.Y.Z` web release tags instead call `desktop-production.yml`, using the
workspace's full release optimizations and producing the
`weblink-windows-x64-installer` NSIS artifact. Desktop keeps its own application
version. These workflows upload artifacts without publishing a GitHub Release.

Desktop builds use Vite's `desktop` mode and default to `wss://ws.webl.ink`.
CI builds read `VITE_WEBSOCKET_URL` and `WEBLINK_STUN_SERVERS` from GitHub
Environment variables in `Preview`/`production`, matching the web channel.
Optional static/HMAC TURN settings use the `VITE_TURN_SERVERS` secret; managed
TURN credentials come from the signaling backend. Public variables also configure
pull-request builds without deployment secrets.
Put deployment-specific `VITE_*` / `WEBLINK_*` values in `apps/web/.env.desktop.local`.
Root `WEBLINK_WEBSOCKET_URL` only overrides development, so localhost settings
do not become the packaged signaling endpoint.

## Runtime boundaries

- The Rust shell is organized by feature. `lib.rs` assembles services and application
  lifetime; `capabilities.rs` queries feature implementation availability. Input and
  keyboard availability do not grant OS access: starting an operation must still
  check its native environment. Capability queries do not create input actors or hooks.
- `remote_control/` contains shared IPC, owner lifetime, host protocol/consent,
  bounded transport queues and local capture binding. Its orchestration compiles on
  every host. `desktop-input::session::Session` is the native actor boundary;
  Windows retains its serialized queue, authorization engine, safety hooks and
  input-release behavior. An unimplemented backend cannot open an input owner.
- `preview` and `keyboard` expose common command signatures and select their
  native implementations inside the feature. Windows preview uses WebView2 shared
  buffers. Notifications use the Windows backend for permission queries, presentation
  and actions. Only Windows is a supported desktop target; other platforms retain
  unavailable implementations for host compilation and shared-logic tests.
- Native capture and media still share `desktop-capture`; D3D frames, encoding,
  source enumeration and physical desktop geometry currently target Windows.
  Extracting shared control orchestration does not make these media/input contracts
  portable or provide macOS/Linux capture support.
- Desktop version starts at `0.1.0`, independently of the website. Update
  `apps/desktop/package.json` and its Rust crate version together. Tauri reads
  the JS manifest version and Vite uses it for About and `version.json`.
- Desktop builds omit the PWA manifest, service worker, share target and web
  update prompt. Updates currently mean installing a newer desktop package;
  automatic updates need a separate signed release channel.
- The shared `@weblink/platform` contract has browser and desktop adapters.
  `runtime_capabilities` reports Windows native capture support when available;
  Windows remote input is available with explicit local approval.
- Only the local main window can query native capabilities, control native screen sharing
  and open HTTP(S) or mail links. External links open in the system browser. The window cannot
  navigate to a remote page or create another privileged webview. There are no
  filesystem, shell execution or input-control IPC permissions.
- The main window uses native window controls. Closing it asks by default in an
  app-styled web dialog, with choices to hide to the tray, quit, or cancel. “Remember
  my choice” saves hiding or quitting before performing the action; cancel does not
  change preferences. Settings → Application can restore “Ask every time” or
  select direct exit or hiding; existing saved choices are preserved. The tray restores
  the window, revokes control of this device, or quits the application. A second
  instance also shows and focuses the existing window. If tray creation fails,
  hiding is disabled and the close prompt offers only quit or cancel.
- Files, clipboard, camera and microphone use existing WebView browser APIs. Native
  drag/drop interception is disabled so the app's existing HTML drop handlers
  receive files. The host automatically grants camera and microphone access only
  to the local application origin (or the configured development origin). Windows
  refreshes those two WebView profile grants at startup, including older saved
  denials. AppState skips browser permission queries and temporary permission
  probes on desktop; opening a device menu never starts capture. The normal
  microphone/camera controls start capture, and actual OS denials or missing
  devices still update the shared state. Refreshing the list rechecks missing
  devices; a successful capture clears a previous OS denial. Speaker selection uses exposed devices
  or retains the default output without requesting microphone access. OS privacy
  settings remain in force. File selection/download still requires WebView2
  acceptance; Windows screen sharing uses the native path below.
- IndexedDB and local storage belong to the application WebView profile under
  the OS application-data directory. Browser history is not automatically
  imported; development and packaged origins have separate storage.

## Application window behavior

“Hide window after approving remote control” is off by default and applies to the
host, including approval through a remembered client permission. Only a successful
native grant hides a visible, non-minimized window. Native grant termination
restores the window only if that grant automatically hid it; a manual show/hide
cancels automatic restoration. Replaced or stale grants cannot restore another
session's window. This does not depend on WebView status polling. Stopping the
controlled capture explicitly closes its control channels and invalidates its
input binding before capture teardown; other shared displays remain available.
Hiding or minimizing does not dispose room, media, or host input owners. Controller-side keyboard capture still stops on loss of
foreground focus. Explicit room leave, page reload, window destruction and process
exit keep their existing cleanup behavior; choosing Quit in the tray always exits.

The main page subscribes to native close requests. Repeated close attempts share one
prompt, and replies must match both the page subscription and pending request.
Reloading releases the subscription. Before the page subscribes, or if its channel
rejects delivery, normal native close remains available. The tray's Quit command
can always exit independently of the renderer.

Windows WebView2 is started with background timer/process throttling disabled;
the desktop renderer also holds a shared Web Lock for its lifetime to resist
background freezing. Capture leases remain active and still expire if the renderer
actually stops responding. These measures rely on WebView runtime behavior, so
background operation must be checked when changing the supported runtime.

Picture-in-picture preferences live in Application settings and import the former
meeting preference. Browsers keep their existing PiP lifecycle and permission rules;
the automatic toggle is disabled where document PiP is unsupported. On desktop,
PiP turns the main window into a resizable, always-on-top window with a custom drag
bar and compact meeting controls, retaining the current grid or featured layout.
Manual entry remains available without a pinned source or live video, including
multi-participant avatar grids. The toolbar entry reflects native window support,
not the current main-view selection; only automatic entry requires live video.
It retains the same renderer, media players and control session. Window bounds animate
on entry and return, and follow the system reduced-motion preference. Native frames
are cancellable and only one is queued at a time; hiding or reloading restores bounds
immediately and invalidates pending frames. Returning or
closing the small window restores its previous size, position and window flags;
closing the small window does not quit. Tray Show also restores the main window.
Source removal, room leave and page reload release native presentation ownership.

Desktop automatic PiP activates when an eligible video view loses foreground focus
or is minimized. Active dialogs, source pickers and an explicit hide-to-tray prevent
automatic entry. Focusing the small window keeps it usable; use its return button to
restore the main window. Explicit host-control auto-hide keeps its existing behavior.

Application settings also contain the existing auto-join preference and a desktop
launch-at-login switch. Auto-join keeps its existing profile value and room behavior.
Launch at login reads the OS registration rather than storing a second preference;
only changing that switch enables or disables registration. Keyboard forwarding and
exit shortcuts remain in Remote control settings alongside touch input preferences.

Login startup uses `--autostart`. Its native configuration defaults to hiding in
an available tray and can instead show the main window; manual launches always
show the window. An unavailable tray or unreadable startup configuration falls
back to a visible window. Changing the startup display preference does not enable
OS registration.

Both debug and release Windows executables use the GUI subsystem, including when
launch-at-login points at a development build. The autostart plugin registers the
current executable directly with `--autostart`; no terminal or shell wrapper is needed.

## System notifications

Notification preferences are shared by the Web and desktop UI: messages, control
requests, speed-test requests and completed file transfers are enabled by default, only while the
window is unfocused. Content preview and sound can be disabled separately. Browser
permission is requested only by explicit header or settings actions. New-message events follow
durable insertion; loading history, duplicate delivery and ACKs do not notify.
Transfer completion requires an observed state transition in the current session.

Browser permission is reconciled from Notifications and Permissions APIs and
refreshed automatically on focus, visibility, page restoration and permission changes;
settings do not expose a manual permission refresh. An
unresolved prompt is not treated as a grant or retried repeatedly. Android installed
apps may require changing the app's own notification settings; website permission
cannot establish the OS notification-channel or Do Not Disturb state.

Message previews include the sender's avatar and name; group titles also identify
the room. UI fallback avatars use a shared SVG with consistent gradients, initials
and glyph alignment; notifications rasterize that same SVG to a small PNG. Disabling previews hides identity as well
as message content. Avatars are bounded PNG data URLs; the desktop validates and
materializes them locally for the OS and removes them when the notification ends.
An invalid image falls back without suppressing the message. Windows displays the
avatar in its circular app-logo slot; browser icon presentation follows the OS.
The Windows notification source separately registers the bundled Weblink icon in
the app identity, leaving the sender avatar in the content area. Its PNG stays in
the application's local data directory across individual notification lifetimes.
Web notifications supply a separate monochrome app badge where supported, and use
the app icon for notices without a sender avatar; the browser controls source branding.

The browser uses Web Notifications, with Service Worker actions when available;
otherwise clicking opens the application conversation. Worker actions target the
creating page and subscription, never another tab. Windows uses native WinRT
Toast notifications with inline message replies and approve/decline buttons.
Windows notification status queries are read-only. For a fresh unpackaged app,
`ToastNotifier.Setting` can return `ERROR_NOT_FOUND` before its first notification.
That maps to `unknown`, distinct from granted, denied and unavailable. The first
real notification may still be dispatched without a permission prompt; Windows
enforces its own notification settings. Only dispatch registers the app identity.
No temporary notification is sent to discover status. Other native failures remain
errors; settings distinguish loading, retryable failure and unsupported environments.
Other desktop systems report notifications as unavailable. OS notification settings
can suppress presentation or sound on Windows.

Actions require a live subscription and unexpired notification. Approval also
rechecks the exact pending consent through the existing control service; cancelling
that request retracts its notification. Actions are consumed once before asynchronous
work. Replies use the regular messaging service and never clear another draft;
failed local acceptance retains the reply in the conversation draft. Delivery
failure after acceptance belongs to the stored message and its existing retry flow.
Speed-test notifications share the exact pending approval with the in-app toast and
panel, including its original 20-second deadline. Approve/decline settles that
request once; opening the notification only opens the peer's speed-test panel.
Cancellation, connection loss, expiry or an in-app response retracts the notification.
A late action cannot approve a newer request from the same peer. Speed-test alerts
have their own category switch and follow the common permission, focus, preview and
sound preferences; disabling alerts does not disable in-app approval.
Declining from either the in-app toast or a system notification closes the request
without opening the speed-test panel.
Reloading/closing releases callbacks and retracts notifications on Windows and in
browsers.
This is notification of live local events, not push delivery while the app is closed.

## Native screen sharing

The meeting screen-share button opens a display/window picker on supported
Windows systems. The picker separates screens and windows, lists sources in a
single column with their dimensions and supports window search. Selecting a source
loads its thumbnail in the adjacent preview pane; sources are not captured for
thumbnails before selection. Capture methods
are configured in Settings and read by the picker for the selected source type. Screens
can use DXGI Desktop Duplication or Windows Graphics Capture (WGC); windows use
WGC. Availability is probed in the current interactive session. While DXGI capture
is active, queries reuse that running session as evidence of support; they must
not attempt a second duplication of an output already owned by this process.
After capture stops, availability is probed again. Auto prefers DXGI
for screens and WGC for windows; explicit unavailable choices fail instead of
silently capturing through a different backend. Defaults remain 1080p / 30 fps. Settings → Audio & video
controls resolution (up to 2160p), frame rate, bitrate and degradation.
Desktop frame-rate choices use connected displays' current refresh rates, including
high-refresh choices above 60 FPS. Common lower rates remain available; unknown
display information and browser builds use 15/24/30/60 FPS. Reopening the controls
refreshes display information, and a saved unavailable rate is lowered to the
nearest offered rate. Browser builds hide native capture and encoder controls.
These are upper limits, not throughput guarantees. Camera and browser screen
capture use the same resolution/frame-rate preferences. Resolution, frame rate,
bitrate and degradation changes update active browser and native streams without
recreating capture or WebRTC connections. Rapid edits are coalesced and native
preview tracks are never constrained or re-encoded by the WebView. Codec, encoder
and capture backend changes apply to the next share. Audio consent and mute state
are preserved. Invalid live limits are rejected before commit; constraint and sender
parameter failures are reported to the user.

Software formats come from libwebrtc's sender capabilities. Hardware H.264 and HEVC encoders
come from Media Foundation hardware-transform enumeration followed by activation
and input/output type negotiation, not GPU model names. Auto prefers an available
H.264 hardware encoder by default; an explicit format selects a matching hardware
encoder when available, otherwise a supported software encoder. Settings combines encoder and format into one
selector with Auto and the detected hardware/software format combinations.
Existing preferences remain readable; unavailable saved combinations are marked
instead of silently replaced. Each remote peer owns its hardware transform and
encoded-frame source, with independent bitrate and keyframe feedback. A selected
codec restricts negotiation to that format: incompatible receivers fail instead
of silently switching codecs. Driver/session limits and accepted resolution/rate
combinations still apply. The Windows local preview does not create an encoder or
WebRTC connection; encoder selection and bitrate govern remote publication.
Camera and microphone still use browser codec preferences. Saved bitrate and browser
codec preferences retain their existing storage keys.
The Media Foundation path is vendor-neutral: AMD, Intel and NVIDIA hardware
depend on the installed GPU and driver exposing a compatible H.264 or HEVC transform.
A CPU brand alone does not establish hardware encoding support. HEVC uses Main
8-bit NV12 input and the H.265 RTP codec. Only a session with an activated HEVC
transform opts into the Cargo fork's external-HEVC factory; normal/software factories
do not advertise an encoder they cannot provide. Existing H.264 encoder IDs stay
stable; HEVC IDs include a codec suffix for multi-codec driver registrations.
Receivers must negotiate H.265 support. A rejected video answer fails promptly
with a compatible-format suggestion, without waiting for ICE or silently switching
formats. Native AV1 hardware publication is not implemented.

Negotiation alone does not prove decoding. Receivers observe decoded-frame progress
while video RTP is arriving, and report terminal codec/playback failures inside the
existing source card. Cards use publication identity across media reconnection.
Terminal failures do not automatically switch codecs or retry; restarting sharing
creates a new publication. Transport retries remain bounded, with their budget reset
only after sustained decoded progress. Additive `receiver-status` messages report
healthy/unsupported receivers; `stop.retry` preserves the card during transport repair.
Explicit stop also clears that retained card during backoff or an unfinished offer.

Browser/WebView decoding follows the runtime's negotiated receiver capabilities,
not the sender's GPU or Windows media-file codec extensions. A runtime must expose
H.265 in WebRTC to receive HEVC; browser and WebView versions can differ. WebRTC
does not expose a per-receiver switch that forces GPU decoding. Keep browser GPU
acceleration enabled and inspect the actual decoder implementation and decode
time in stream statistics when available. Chromium can hide the implementation
and hardware-efficiency fields in receive-only contexts; missing fields do not
prove software decoding. Native screen receivers already request zero additional
audio/video jitter buffering, subject to the browser's loss-recovery and A/V sync
requirements. Experimental codec flags are not enabled by the application.

Each native peer sets both its video RTP encoding limit and its transport-wide
maximum. The transport budget follows the configured video maximum plus the
128 kbps audio allowance when that peer sends audio, on creation and live updates.
These settings share the existing rollback path. An RTP encoding limit alone does
not update GoogCC's probe ceiling: without a finite transport maximum, the bundled
engine defaults bandwidth probes to 5 Mbps. This is a probing limit, not a hard
media throughput cap. Native screen factories also opt into periodic ALR probes
so recovery can continue during low activity, with the engine's default cadence
and scale. No minimum bitrate is forced and changing the ceiling does not reset
the starting estimate. Available bandwidth remains an estimate of that peer's
path, rather than the link speed or a promise to send at the configured maximum.

Hardware encoding keeps the selected frame cadence independent of WebRTC's
observed input frame rate, so motion can resume after static content. Remote peers
start conservatively and apply bandwidth reductions immediately. Upward updates
are coalesced over 50 ms and then follow the latest allocation directly, without
an additional multiplicative recovery ramp. Targets are quantized down in 16 kbps
steps, preserving smaller positive allocations.
The encoder target stays within the peer's latest bandwidth allocation
and configured bitrate cap; WebRTC retains congestion control and pacing. These
limits govern the target rate, not the size of individual keyframe bursts. Where
the driver supports it, the hardware encoder requests a one-frame HRD/VBV budget
at the configured bitrate ceiling before negotiating media types. Some drivers
latch this capacity at initialization and silently ignore later writes. Using
the ceiling instead of the conservative startup estimate leaves room for bitrate
recovery. A driver that rejects the early request gets another attempt after type
negotiation. Hardware also requests the low-complexity quality/speed setting (33),
favoring interactive latency at a potential cost to compression efficiency.
Both controls are optional and their readback remains visible in diagnostics. Lowering
the live bitrate ceiling takes effect immediately; raising it waits for new
transport feedback. Explicit frame-rate or bitrate-ceiling changes recreate
only the hardware transform to refresh its fixed media type and buffer budget;
the RTP session stays connected. Ordinary bandwidth feedback updates the target
bitrate on the running transform without restarting it.

After the first encoded frame binds the source to its sender, transport rate
feedback reaches the source independently of subsequent frames and wakes the
hardware worker. The notification holds only a weak worker reference and is
cleared on all worker exits. A zero allocation pauses raw input without writing
an invalid zero bitrate to MF; positive feedback resumes it and requests a fresh
keyframe. Existing byte debt survives pause and recovery. Fixed codec controls
are read back on transform initialization, not on every rate update.

The **Show stream statistics** action is available in the main picture's controls
when it has video. Its overlay is temporary state for that picture, defaults to
off, and is discarded when the picture is removed or replaced. It is not saved
in application preferences. The overlay samples only while displayed. It keeps
each peer and local preview separate; rates and
per-frame processing times use successive counter differences. Unavailable values
remain absent. Actual bitrate is RTP payload byte growth over the report interval,
independent of display FPS. Sender rows separately show the WebRTC target, the
last bitrate successfully applied to MF, and the selected transport's outgoing
bandwidth estimate when available. These are budgets, not measured traffic or
guaranteed capacity. Each receiver has its own encoder and congestion feedback;
compare its sender row with that same receiver, not another peer's bitrate. A
receiving browser's outgoing bandwidth estimate describes the reverse path and
is not displayed as incoming video capacity. Native hardware encode time measures accepted MF input to output,
including driver and output-delivery latency, rather than WebRTC's encoded-frame passthrough.
Hardware input wait is measured separately. Capture-to-encoded time starts at
arrival in the application's capture callback; cached static repeats are excluded.
Packet-send queue delay uses packet counts, not frame counts. RTT belongs to the
selected ICE candidate pair. Neither RTT nor a sum of these overlapping stage
measurements is a glass-to-glass latency measurement. Only small counters cross
Tauri IPC; statistics never change capture, transport or borrowed track lifetimes.

Native capture retains the original GPU texture and reuses its staging resources.
For unrotated sources, a D3D11 shader scales to the selected dimensions before CPU
readback and color conversion. DXGI cursor coordinates and pixels follow that scale.
Unsupported GPU processing falls back to CPU scaling; rotated displays retain the
existing rotation path. The original texture preserves detail when increasing live
resolution while the screen is static. Capture
coalesces new content for a single conversion worker. Only the newest pending GPU frame
is retained; the conversion worker owns the frame-rate cap. Software input follows
an absolute cadence, while hardware capture starts promptly after idle and skips
missed deadlines. Hardware MFT input/output readiness wakes its worker through
Media Foundation events; there is no second encoder FPS gate or output polling
timer. Each encoder keeps only its latest pending input. Reconfiguration and
shutdown release callback state without retaining the capture session. On Windows versions supporting
WGC's minimum update interval, capture requests updates at a 1 ms minimum interval
and the worker enforces the selected output rate; older Windows versions retain
the OS default. The worker preserves the latest pending frame without
losing the final update when a screen becomes static. GPU mapping/conversion runs
outside the async executor. Hardware encoding repeats static content at most twice
per second. Software encoding reuses the latest converted pixels at the selected
cadence: sparse input otherwise inflates its per-frame budget when motion resumes.
This does not repeat GPU readback or pixel conversion. Software H.264 uses the
real-time rate-control preset. Its single-stream OpenH264 encoder delegates frame
dropping to WebRTC rather than also skipping consecutive frames inside the codec
after large scene changes. OpenH264 still controls quantization; WebRTC retains
its frame dropper, bitrate adjustment, congestion control and pacing. Limited
bandwidth can still reduce frame rate or quality according to the selected
degradation preference. This policy is scoped to the native screen factory's
software H.264 backend. Hardware pass-through disables the encoder-input rate
dropper because its inputs are already compressed reference frames. Hardware
workers apply transport bitrate feedback to MF and account for actual encoded
bytes with a bounded 50 ms burst allowance. When a driver overshoots its accepted
target, raw inputs are skipped before encoding; completed encoded references are
preserved. Idle time cannot bank an unbounded burst, and bitrate reductions retain
existing byte debt. Pipeline diagnostics expose `encodedBytes` and
`rateLimitedInputs` separately from input replacement and player drops. This
preserves bitrate limits rather than promising the requested FPS for arbitrarily
complex content at insufficient bandwidth.
The configured `maxBitrate` is the video bitrate ceiling; the current encoder
budget follows transport feedback up to that ceiling. Live setting changes update
both the RTP sender and hardware worker. There is no additional fixed Mbps cap:
the 50 ms burst allowance is converted to bytes at the current budget, and startup
estimates do not prevent later recovery toward the user's selected maximum.
Native screen receivers
request minimal playout buffering where the browser supports it; network jitter,
encoding and decoding can still add delay.
Native senders additionally advertise a negotiated RTP playout-delay range of
0–0 ms for interactive screen viewing. Chromium then decodes complete frames and
presents the latest frame without an additional presentation queue. A zero minimum
with a positive maximum selects its low-latency renderer, whose
[fixed 60 FPS frame-duration assumption](https://github.com/chromium/chromium/blob/main/third_party/blink/renderer/modules/mediastream/low_latency_video_renderer_algorithm.h)
can discard decoded frames from higher-rate streams; a positive minimum instead
adds timestamp-based presentation scheduling. Receivers without the extension
keep their normal buffering. This hint prioritizes freshness over jitter smoothing
and audio/video synchronization delay; packet arrival, decode and display refresh
still limit playback. It is not an end-to-end deadline or a zero-drop guarantee.
The video pacer has 1.5× burst headroom relative to its bandwidth estimate;
encoder bitrate limits, congestion control and retransmission remain active.
Both options belong to the native screen session's factory, not process-global
settings. The binding changes and upstream versions are documented in the fork's
[WEBLINK.md](https://github.com/99percentpeople/rust-sdks/blob/40d325ebeda3567cf25dc742b6062bd7c5c9cc9a/WEBLINK.md).
Update the fork first, then the full Cargo revision and lockfile together; normal
builds never follow the branch tip. Preserve upstream license notices and verify
native-to-browser RTP when upgrading the bindings.
The local preview reads packed I420 frames through a read-only WebView2 shared
buffer and submits VideoFrames directly to a generated video track where WebView2
supports it. This avoids the Canvas draw/recapture round trip; older runtimes keep
the Canvas capture fallback. Both preserve existing layout and playback ownership,
and neither is sent through browser RTC. One request/submission is allowed in
flight: the WebView copies shared memory into a VideoFrame before requesting
another write, and unchanged pixels are not recopied. The generated track retains
only the latest frame and repeats it at most twice per
second during static content, so a newly attached player can display it without
another shared-memory copy. Closing releases the writer and retained frame.
The preview has no codec, bitrate, encode/decode delay or jitter-buffer statistic;
only its available dimensions and preview-submission counters (including static
refresh submissions) are shown. The overlay separates submitted/encoded/decoded
FPS from the video element's presentation FPS, using cumulative compositor
counters where supported. Player
drops and receive-to-presentation timing are shown only when available. These are
browser presentation measurements, not physical display scan-out or end-to-end latency.
Closing or navigating releases both shared-buffer mappings. A silent local audio
track carries consent, mute and ownership through existing controls; actual system
audio remains native.
The preview has no network feedback and cannot throttle remote senders. Window resize
updates are observed after the source repaints at its new size.

`capture_pipeline_stats` exposes bounded rolling mean/P95/max timings for lock wait,
GPU preparation, Map, composition, conversion, CPU scaling and publication, plus
input/readback dimensions, GPU fallback reason and active peer/encoder counts.
It also reports capture wait, per-peer hardware input wait, input-to-output and
capture-to-encoded distributions, replaced input counts and in-flight samples.
Hardware controls include the requested value, setter result and driver readback;
an accepted setter alone does not establish that a low-latency/CBR/buffer request
was honored. Unsupported optional controls remain diagnostic and do not silently
disable otherwise usable hardware encoders.
Preparation times measure CPU submission; GPU completion wait appears in Map.
These diagnostics exclude network transit and presentation latency.

DXGI enables D3D immediate-context thread protection before duplication starts:
DXGI acquisition/release and the asynchronous GPU readback worker share this
context, so locking only the readback calls is insufficient. Acquisition polls with
a zero timeout and waits outside the D3D call when no frame is available, allowing
the conversion worker to map its staging texture without waiting for a new screen
update. DXGI handles display
rotation and its separate color/monochrome cursor. Display
mode changes, disconnection or access loss end the capture and require selecting
the source again. Native frames still pass through CPU readback/conversion before
software or hardware encoding; hardware input uses libyuv's native I420-to-NV12
conversion. GPU zero-copy remains separate work. Browser screen sharing and microphone/camera behavior are retained.

The native source picker defaults “Share audio” on for each new selection.
It captures system playback for both display and window shares, excluding the
Weblink process tree so received meeting audio is not sent back. Windows process
loopback requires Windows build 20348 or newer; disabling audio keeps video-only
capture available. Startup failures are reported instead of silently omitting
requested audio. PCM is captured on a dedicated WASAPI worker and sent directly
to native WebRTC/Opus; it never crosses Tauri IPC. Audio capture ends with the
screen session. Preview audio is excluded from browser re-publication and local
playback, while received audio belongs to its screen's existing mute controls.

Display and window inventories/backend dispatch live separately in
`crates/desktop-capture/src/backend/windows/{screen,window}.rs`. `CaptureOptions`
is independent of `MediaOptions`. Native consumers can use
`CaptureService::start_with_sink` and `surface::FrameSink` without a media session:
the callback borrows a GPU texture, rotation and optional cursor metadata until it
returns. A consumer must copy retained frames and keep its own queues bounded.
This is the capture boundary for future remote desktop; it grants no remote input
capability. The service owns a persistent WinRT apartment so repeated capability
queries cannot invalidate WGC activation factories.

Each remote peer receives video directly from Rust over its own send-only WebRTC
connection. Raw local presentation is independent and its tracks are excluded
from browser senders. Streaming pixels never use Tauri invoke/event payloads;
only the WebView2 shared-memory mapping exposes preview pixels to the local page.
The picker separately requests one PNG thumbnail (at most 640×360) over binary IPC.
Monitor thumbnails use a single GDI transfer directly into a small bitmap,
independent of the streaming backend; no WGC/DXGI session is opened. Window thumbnails
use WGC with OS-approved border suppression and release resources after one frame
or a two-second frame timeout. If border suppression is unavailable or denied,
the window preview stays unavailable instead of starting a capture with a border.
Neither path replaces an active share. The preview frame stays 16:9 and preserves
the image aspect ratio. The UI
keeps one request in flight, discards stale results and releases image URLs on
selection changes or close; a preview failure does not prevent sharing.
The native connection uses the existing ICE/TURN credential
loader and relay-only setting; raw local preview does not use ICE or TURN.
Initial room binding, late join and capture changes all use this same publication
path; reconnecting must never republish the local preview through a browser encoder.

The ordered `weblink-desktop-media` DataChannel belongs to the authenticated room
PeerSession and carries a capability handshake, source/session identities, SDP
and incremental ICE candidates. Peers advertising `trickleIce` exchange SDP
immediately, allowing reachable routes to connect while slow STUN/TURN requests
continue. Candidates are scoped to their media connection and queued until its
remote description is applied. Older native receivers use the complete-SDP
fallback. Old clients keep chat/file/camera functionality but must update to
receive native screen shares. A screen is identified by its control session and
single video transceiver, independently of the ordinary connection's MIDs.
Peers advertising `multiScreen` send all active publications, each with its own
media connection, ICE queue, bounded retries and statistics. Receivers combine
the tracks for presentation while retaining each connection's audio/video ownership.
Peers without this capability receive the first active publication; stopping it
promotes the next one without replacing the room connection.
Closing/replacing that channel releases its native senders and remote receivers.
An unexpectedly closed dedicated channel is reopened by its negotiation owner while
the main room channel remains ready. A native input worker failure opens a fresh
owner and rebuilds eligible media bindings; previous input grants are never replayed.
Remembering an allowed peer leaves its existing transport and consent intact.
ICE failure retries are bounded; stopping and restarting sharing resets them.

Adding a native share retains existing screens and windows. Each capture owns
its raw preview, encoder, remote peers and heartbeat independently (up to 16 captures).
Explicit stop, source closure, application exit and a 60-second lost-client lease
release the affected capture and transports; application exit releases all of them.
Leaving a room releases its peer connections but
retains an explicitly running local capture for rejoin. Pending selections cannot
start in a replacement room. Stale session IDs cannot stop a newer capture.
Transient status IPC failures retry without ending capture; native terminal status
retains its error and stop reason. Failed per-peer hardware encoders close only
their own transport and retain bounded error diagnostics. Capture/readback and
system-audio failures still terminate the affected capture with native diagnostics.

**Settings → Advanced → Native screen capture test** remains a local diagnostic
using the same capture service with an independent session.
It reports capture arrival statistics without mapping or transmitting pixels.
Closing this diagnostic panel stops only the capture it owns.

For a native smoke test, run this in an unlocked interactive Windows session:

```sh
cargo run -p weblink-desktop-capture --locked --example self_test
```

It creates and captures its own temporary window, checks frame delivery, resize,
stop/restart and source closure, then removes the window. It does not capture
existing windows or a display. `media_self_test` additionally accepts a temporary
exchange directory, an optional codec MIME type (for example `video/vp8`), and
an optional encoder ID (`software` by default, or a detected `mf:...` ID):
it exercises 640×480 / 15 fps / 1 Mbps limits, writes `offer.sdp`, accepts a browser's `answer.sdp`, and
responds to `resize` / `motion` / `done` marker files. The `motion` marker
updates only the test window until removed, allowing receiver FPS checks. Use browser inbound RTP/decode counters
to validate video delivery and resize before writing `done`; no personal desktop
content is used by either harness. `display_self_test` separately exercises the
available screen backends and their stop/restart lifecycle in an interactive
Windows session. It counts borrowed GPU frames without reading, saving, encoding
or exporting display pixels. Windows unit tests exercise synthetic hardware H.264 and HEVC
when an activated hardware transform is available; this is distinct from proving
all vendors, driver versions or a sustained target frame rate.

`multi_media_self_test` takes a fresh exchange directory, creates two test windows
and writes `offer-1.sdp` / `offer-2.sdp` for two browser receivers. Supply matching
`answer-1.sdp` / `answer-2.sdp`; verify both decode, then write `stop-first`.
After `first-stopped` appears, verify the second receiver still decodes at its new
size, then write `done`. It checks independent raw previews, media handles,
stop, live settings and source closure without capturing existing windows.

`thumbnail_self_test` checks window/WGC and screen/GDI PNG snapshots, repeated requests,
closed sources and preservation of an existing capture. Run it interactively:
`cargo run -p weblink-desktop-capture --example thumbnail_self_test`.
It decodes thumbnails only in memory and does not save or transmit them.

The DXGI readback regression must run explicitly in an unlocked interactive
Windows session. It captures the display into memory, checks software and
available hardware encoding through two WebRTC receivers in the same process,
and repeats stop/start. It does not save screenshots or send pixels to external
peers. Ordinary tests skip it because an SSH or CI session has no interactive desktop:

```sh
cargo test -p weblink-desktop-capture --lib dxgi_readback_reaches_preview_and_remote_after_restart -- --ignored --nocapture
```

## Attended remote control

Windows display shares are view-only until the viewer requests control and the
host approves this request or has saved an allow rule for the client. Browser viewers can request control even though they
cannot host native input. Window shares and older clients remain view-only.
Browser keyboard and mobile text/IME forwarding require the native peer's
corresponding capabilities. The confirmation describes computer-wide
input authority: a display rectangle maps the pointer, not an OS security sandbox.

Secondary meeting views expose their supported remote-control, fullscreen and
picture-in-picture actions. Activating one first promotes that existing tile to
the main view, then starts the requested feature; input forwarding remains owned
by the main view (a single tile is implicitly the main view). Switching or unpinning
it while control is requested/active or a display mode is opening/active asks for
confirmation; cancellation also cancels the requested new action. Confirming ends
those modes before changing the view; it does not stop the shared tracks. Incoming shares preserve a busy main
view. An approved avatar request follows its matching screen as the same control
session; unrelated shares cannot take its place. A source disappearing or the
room ending still performs normal cleanup without waiting for confirmation.

The desktop composition layer binds each connection to its locally owned room,
peer generation, client, capture session, publication and current display geometry.
`crates/desktop-capture` supplies DataChannel ports; it never imports the independent
`crates/desktop-input` authorization/input engine. One authority covers every peer
and source on the computer. Remote messages cannot register a target or approve
consent. Approval is a trusted local policy decision exposed only to the main
desktop window. It does not require foreground activation or physical-click
evidence. Incoming requests use a persistent toast with Approve/Decline actions.
The split Approve button also offers approve-and-allowlist and reject-and-blocklist.
Rules are local preferences keyed by the existing persistent client ID, not by its
editable display name; they are not a separate authenticated device identity.
Blocked clients receive no hosting capability, including after a rule changes on
an existing connection. Native requests are also rejected and active control is
revoked. Removing a rule returns future requests to manual approval.

Settings → Clients & rooms uses the existing client/room preference records for
control and file permissions. Connections are remembered automatically; existing
local history is imported once. Each record opens its own settings. Forgetting a
visible client or the active room restores defaults and retains the record;
forgetting an offline record removes it without deleting conversation history.

A capable desktop also advertises `hello.requestScreen` on the existing native
screen signaling channel. The avatar/camera action can send `control-request`,
`control-cancel`, and receive `control-result`. Approval reuses the meeting capture
owner to share the first monitor (and system audio) with the entire room; an
existing controllable display is reused. No capture starts before approval. The
request then hands off to that publication's ordinary native pointer. A one-use
approval binds the client, peer generation and source for 30 seconds, preventing
a second confirmation without carrying consent to other peers or captures.
Cancellation, room/peer teardown and request expiry invalidate pending startup.

The toast lifetime
is bound to the native consent ID: polling does not recreate it, and cancellation,
expiration or owner teardown removes it. Failed responses remain retryable while
that same request is current.

For mutually capable peers, the native media offer includes `weblink-control`
(ordered/reliable) and `weblink-pointer` (unordered, no retransmission) channels.
The local capability hello precedes publication. Later capability changes rebuild
affected display transports so an existing view-only share can gain control;
unrelated window shares keep their connections. Superseded capability reads cannot
overwrite a newer permission decision.
Input goes directly from those native callbacks to bounded native queues, without
per-event Tauri IPC. The latter is reserved for local owner lifetime, confirmation
and status. Messages are limited to 4 KiB, reliable queues to 128 entries and send
buffers to 16 KiB. Pointer moves coalesce to at most 120 updates/s. Each input is
bound to its grant, connection, geometry revision and activation epoch. Buttons
and wheels include their position; moves have independent sequence numbers and a
reliable-event barrier, so reordered moves cannot jump across a button transition.

The host advertises additive `ready.persistentControl`: approval lasts for the
current room/peer/media binding until explicitly revoked or that binding ends.
A two-second remote heartbeat gap or stale input releases held input but keeps
consent. Local keyboard/mouse activity is not monitored and does not pause or
revoke control. The native sequencer suspends
the old input epoch. After a fresh heartbeat the controller automatically requests
a new activation epoch if the user still intends to control; interrupted input is
never replayed. An explicit end/revoke cannot be undone by a late heartbeat or
activation acknowledgement.
Controllers include a required `activationSequence` on input packets. Each
fresh epoch advances this counter; the native host retains its high-water mark
and rejects retired counters, with no fixed recovery count or growing replay
history. A reliable input sequence gap
releases held input and reports the epoch inactive, allowing heartbeat-driven
recovery instead of leaving healthy heartbeats attached to unusable input.

Temporary ICE disconnection and DataChannel backpressure do not close control.
While the reliable sender is congested, input is interrupted and unsent gestures
are discarded; draining the buffer resumes with a fresh epoch and release barrier.
Native reply queues preserve consent/revoke order, coalesce liveness observations,
and acknowledge input transitions rather than every movement. An inbound network
input burst clears delayed input and resets its epoch while retaining the channel.
A terminal control-channel failure enters the existing media retry path, rebuilding
the peer transport for the same capture; authorization is not carried to a new peer.

Frontend status polling observes native state and applies saved or one-use approvals. Native window/page teardown,
room leave, channel/media closure and explicit revoke own the session lifetime;
a delayed WebView timer or failed status read cannot revoke consent. Stopping a
share or replacing the room/peer ends the grant, and rejoining never restores it.
The header sharing status and Ctrl+Alt+Shift+F10 provide explicit local revocation.

The viewing UI maps only the contained video content, excluding letterbox areas.
The desktop tile action bar has one icon button for request, cancel request and end control.
On mobile and coarse-pointer devices, tile actions share one dropdown button with
labelled entries. Its portal stays inside the fullscreen container when fullscreen.
Approval activates input automatically; there is no user-facing pause mode. Blur,
hidden view, lost drag capture and settings changes release the current gesture
using a fresh acknowledged epoch, without ending consent. The configured viewer
shortcut releases captured pointer and keyboard input without ending consent.
The existing video node, audio routing and statistics remain owned by the player.

### Pointer capture and keyboard input

In Local cursor mode, an approved controller's mouse over the video content hides
the cursor composed into the shared screen video. Leaving the video, touch input,
loss of focus, capture mode, input suspension and ending control restore it. This
applies to the shared capture (including its preview and other viewers), not the
host's physical cursor. DXGI recomposes retained frames; supported WGC display
sessions toggle cursor capture without restarting the stream. The optional
`cursorVisibility` capability keeps older hosts compatible; cursor updates require
the current grant, media generation, geometry and active input epoch.

Settings → Remote control provides two pointer behaviors. **Local cursor** is the
default: mouse coordinates map to the displayed video, and focusing the screen enables
physical keyboard forwarding. The header keyboard switch can disable it immediately.
**Capture and hide local cursor** uses [Pointer Lock](https://w3c.github.io/pointerlock/)
after clicking the remote surface. The capture click is consumed locally. Movement,
buttons and wheel then use the existing relative-pointer channel at the host's current
cursor position; the frozen local coordinates are not sent. An unsupported or rejected
capture leaves keyboard input local and allows another explicit attempt.

In capture mode, physical keyboard forwarding requires an actual pointer lock on the
active surface; keyboard input stops together with pointer capture.
The shared release shortcut (Ctrl+Alt+Shift+Q by default, optionally Ctrl+Alt+Shift+X)
releases pointer and keyboard capture together, including when keyboard forwarding is
disabled. It preserves the approved control connection. Browser Escape may also unlock.
Blur, hidden documents, mode changes, lost control and teardown release capture and
held input. A late lock completion is released; returning focus never recaptures.
The host's independent Ctrl+Alt+Shift+F10 emergency revocation remains unchanged.
The keyboard forwarding preference is enabled by default. The keyboard
switch in the room header appears only while controlling a remote screen that supports
keyboard input; hosting a share or merely viewing one does not display it.
It toggles the same saved preference immediately;
disabling it releases keyboard input and closes the soft keyboard, while pointer
control and consent remain active.

Focus the active remote surface (and capture it in capture mode) to forward physical keys. Local chat, settings and
other inputs do not forward keys. Browser [physical key codes](https://www.w3.org/TR/uievents-code/)
map to the existing Windows scan-code whitelist and use the remote keyboard layout.
The receiver injects them through the existing [scan-code input path](https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-keybdinput).
Letters, digits, editing/navigation keys, F1–F12, left/right modifiers and the numeric
keypad are supported when the browser delivers those events. Pause, PrintScreen,
unsupported international keys and OS-reserved secure sequences are unsupported.
Local composition events are not forwarded as physical keys.

Native `ready.keyboard: true` opts into reliable `key` packets containing `scanCode`,
`extended` and `down`. They share the current grant, geometry, input epoch and ordered
sequence checks; they never use the lossy pointer channel. Held-key repeats produce
repeated downs with one owned release. Blur, transport interruption and teardown
clear local key ownership; late releases/repeats do not replay old presses. Changing
the keyboard preference releases owned keys immediately without ending consent.

On Windows Tauri, Settings → Remote control also exposes system-shortcut forwarding,
enabled by default. It uses a controller-side native keyboard hook only while the
approved remote surface has focus, owns pointer lock if capture mode is selected, and
the shared keyboard toggle is on. The
foreground native window must also match. In that interval, supported scan codes,
including Alt/Win combinations, come from the native channel; DOM handlers do not
send a second copy. Local editors, dialogs and the soft-keyboard editor use their
usual paths. Turning off system shortcuts restores browser key handling.

The [low-level hook](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelkeyboardproc)
runs on a dedicated message thread and only writes to a bounded queue; IPC delivery
runs separately. Injected events are ignored to prevent input feedback. Keys held
before capture remain local until released. Frontend consumption acknowledgements
renew a 750 ms native lease every 200 ms, with at most 64 unacknowledged events;
events older than 100 ms or a sequence gap stop forwarding and reset the input epoch.
Late startup or delivery cannot attach to a different focused screen. Focus loss,
window teardown and page navigation stop capture independently of the renderer.
After stopping, the hook can drain only previously captured key releases for up
to two seconds; it never captures new background presses. A failed capture requires
another click on the remote screen, and does not revoke pointer control.

The chosen exit chord is recognized natively, releases pointer lock and keyboard
capture together, and its final key is not forwarded.
Ctrl+Alt+Shift+F10 also ends controller input and invokes the local host's emergency
revocation if this app is hosting control at the same time. This does not add secure
desktop or Ctrl+Alt+Del support. Real Windows shortcut behavior requires manual
acceptance; compilation and ownership tests do not prove OS shortcut interception.

In either pointer mode, the keyboard action on an actively controlled screen
synchronously focuses an invisible text editor within that screen, including in
fullscreen. This explicit soft-keyboard path does not require pointer lock. Mobile browsers
open their system keyboard from this user gesture; there is no custom input panel
or key toolbar. The editor remains focusable, without taking space or intercepting
pointer input. The tile action menu stays visible on touch devices, including
landscape phones. The editor outlives menu content, and keyboard selection prevents
menu close from restoring focus to its trigger. Hiding the keyboard does not end control.
Pointer interactions with that same controlled screen retain the editor's focus,
so clicking, dragging and scrolling can continue alongside text input. Other editors,
dialogs and explicit keyboard dismissal retain their normal focus behavior.
The configurable **Three-finger tap** shortcut defaults to **Show keyboard** in
trackpad mode only. Direct mode forwards all contacts as native touch. Local gestures
share contact, movement and timing detection. The shortcut requires exactly three
overlapping contacts, at most 20 CSS pixels of movement and completion within 600 ms.
The third contact cancels pending trackpad input. A valid three-finger sequence can
complete on native `touchend` or `touchcancel`, because Android may cancel it instead
of delivering releases. Other cancelled gestures, drags, holds and four-finger
sequences do not open the keyboard or fall back to a click. Keyboard activation
stays synchronous with the native event; pointer-only runtimes use pointer completion.
Repeating the shortcut keeps an open keyboard open or requests it again after Back.
Direct touches must begin inside the displayed video. Pointer capture retains them
outside the picture until release, with coordinates clamped to the display edge;
no scroll or window-drag conversion is applied.
Explicit keyboard actions focus the editor with automatic keyboard policy on both
HTTP and HTTPS. The optional secure-context
[VirtualKeyboard API](https://developer.chrome.com/docs/web-platform/virtual-keyboard)
only observes geometry; it does not drive keyboard show/hide. The editor stays
inside the fullscreen container; showing the keyboard does not
request an exit from fullscreen or change global viewport behavior. Keyboard geometry
and visual viewport resizing track OS dismissal, including fullscreen Android Back
when geometry events are absent. After a previously visible keyboard remains hidden
for 180 ms, the editor releases focus and updates its visibility state, so touching
the screen cannot reopen it. A transient zero rectangle does not end text input.
Transient animation gaps, zoom and rotation do not dismiss input. Reopening cancels
pending dismissal without issuing an intervening hide. A real DOM focus transfer,
hidden page, control teardown or explicit dismissal releases input ownership and
restores the editor's policy without hiding another input's keyboard. Both normal
and fullscreen tiles keep playback and input active while their focused keyboard
collapses the meeting grid; source removal and session teardown still disable them.
Reopening after Android Back performs a fresh focus transition without ending the
text-input session or disrupting composition. Ordinary screen taps suppress automatic
keyboard reopening, including floating keyboards that do not resize the viewport.
The editor stages IME candidates locally and sends
only the committed value; it handles final input on either side of `compositionend`
without sending intermediate composition strings or replaying `InputEvent.data`.
This follows the [composition and input lifecycle](https://www.w3.org/TR/input-events-2/).
Backspace, Delete and Enter use physical strokes, and pasted line breaks and tabs
become Enter and Tab. Physical keyboard shortcuts in the focused editor continue
to use the remote computer's keyboard layout. Invisible editing guards on both sides
of the local caret allow repeated Left/Right and Backspace/Delete actions. IME
selection-only cursor moves become remote arrow strokes only outside composition;
the guards are never transmitted.

Native `ready.textInput: true`, together with `keyboard: true`, opts into reliable
`text` packets. Each contains at most 64 UTF-16 units, no control characters and no
unpaired surrogates. A single editor commit is limited to 1024 UTF-16 units before
any prefix is sent; larger pastes are rejected. Packets do not split surrogate pairs.
Text shares the keyboard's grant, epoch and ordered sequence checks and is rejected
by the native engine while a physical key or mouse button remains held. Transport
backpressure stops a commit; unsent suffixes are never retried automatically.

Closing the editor, hiding the page, changing the source or keyboard preference,
and loss of active input discard unfinished composition.
The editor is independent of the video node and does not restart the media session.
OS keyboard/IME behavior still requires real phone acceptance; logic tests do not
prove mobile keyboard presentation or candidate-window behavior.

### Mobile touch input

Settings → Remote control stores viewer-side touch preferences. Trackpad mode
uses relative single-finger motion, tap-to-click, two-finger right click/scroll,
and configurable long-press drag or right click. Long press is triggered by the
phone browser's `contextmenu` event, with no application timer or delay preference;
single-finger touch defaults are preserved so the browser can recognize it. It
applies only to a stationary single-finger gesture. Mouse right clicks continue
through pointer events, and direct touch leaves long-press recognition to Windows.
Pointer/scroll speed, direction and gesture switches are local preferences. The
touch sample rate (30/60/120/240 Hz, default 120 Hz) limits movement and scroll
updates in both modes; actual delivery also depends on browser samples, timers
and transport backpressure. Down/up/cancel transitions and their final movement
flush bypass this limit. Changes release the current gesture and apply immediately.
When available, actual coalesced pointer samples are processed in order for gesture
recognition; predicted samples are never sent. Direct movement still coalesces to
the latest complete contact frame at the selected rate, rather than replaying
every historical position.

Hosts advertise `ready.relativePointer` for native trackpad gestures. These use
ordered `trackpad` input events: move deltas are fractions of the shared display,
and buttons/wheels carry no cached absolute coordinate. The native input thread
reads the actual physical cursor for each event, preserves subpixel motion and
constrains output to the shared display. Deltas coalesce at the selected rate but use
the reliable channel so individual displacement is never lost to packet loss.
Older hosts retain absolute pointer emulation for movement and clicks.
Two-finger scrolling requires the additive `ready.touchpadPan` capability and uses
ordered `trackpad` pan start/update/end/cancel events. Updates carry cumulative
CSS-pixel centroid displacement, coalesced at the selected rate, with the configured speed
and natural-scroll direction. Windows uses a dedicated `PT_TOUCHPAD` device via
`CreateSyntheticPointerDevice2` with physical-size and gesture-only flags; it
handles scroll recognition and inertia. Capability detection checks the actual
API/device availability. There is no wheel-emulation fallback for this gesture.
Pausing, revoking, disconnecting or cancelling ends contacts and native inertia.
Mouse wheels still use the ordinary wheel input path.

Direct touch requires the host's additive `ready.touchContacts` capability. It
sends real Windows `PT_TOUCH` contacts using a dedicated synthetic pointer device,
not mouse emulation. Hosts without this capability can still use trackpad mode.
Each ordered frame includes every active contact, with up to ten normalized
positions and explicit down/update/up/cancel phases. Movement uses the selected
sample rate; stationary updates preserve native press-and-hold recognition. Gesture
interpretation belongs to Windows and the target application. Letterboxes never
generate direct contacts; positions map to physical display pixels without an
extra DPI scale factor.

Direct mode's touch-property switch (disabled by default) forwards browser-reported
pressure and contact area. Optional `pressure` is in [0, 1]; `width` and `height`
must be a pair in (0, 1], normalized against the displayed video content. Unknown
contact geometry (the browser's 1×1 default) is omitted. The host validates these
fields, maps pressure to Windows' 0–1024 range and clips physical contact rectangles
to the shared display. Injection sets only the corresponding `TOUCH_MASK_*` bits;
absent properties retain native defaults. Stationary property changes still produce
updates, and UP releases pressure after any final movement. These are additive
fields: older senders omit them and older hosts ignore them. Trackpad mode continues
to recognize mouse and scroll gestures locally; it does not forward raw touchpad
contacts or touch pressure. Browser-reported properties may be fixed fallback
values; forwarding them does not establish hardware pressure or area support.

The native engine validates contact ownership and transitions before injection.
Pause, cancellation, mode changes, revoke, session loss and lease expiry release
owned contacts. Cancellation covers the whole gesture and destroys its dedicated
device, producing canceled touch events rather than completing a tap/drop. A new
device is created on the next gesture. Touch cannot mix with held mouse buttons or keys. The existing
grant, epoch, bounded queue and stale-input rules also apply to touch. Synthetic
pointer creation failure disables direct touch without disabling mouse control.

`NativeCapture.displayLayout()` / `capture_display_layout` reads physical display
bounds, virtual-desktop bounds, orientation and optional OS resource scale without
opening capture. The scale is metadata, not a multiplier for these coordinates.
The opaque revision changes on an observed layout change or failed query and is
local to the capture service lifetime. Native `display_geometry(session_id)` also
requires an active monitor capture and does not renew its lease. This inventory
is not an authorization or a display-change subscription; input integration must
invalidate ownership on topology/session events as well as query failures.
Windows queries use [EnumDisplaySettingsExW](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-enumdisplaysettingsexw)
for physical pixels independent of DPI virtualization.

Read-only Windows inventory check:
`cargo run -p weblink-desktop-capture --example display_geometry`.
The shared browser/Rust wire fixtures live in
`test/fixtures/remote-control-signals.json`; run the Rust contract/lifecycle tests
with `cargo test -p weblink-desktop-input` and the browser tests with
`bun run --cwd apps/web test test/unit/remote-control.test.ts`.
These checks do not constitute actual remote keyboard/mouse acceptance.

### Native input worker

The native owner registers verified room/media bindings and physical display
geometry. One worker serializes consent, grant validation, input and cleanup;
`Ctrl+Alt+Shift+F10` is registered before it can accept a grant. Hotkey or
session-notification registration failure makes startup fail. Remote input never
selects arbitrary HWNDs, scan codes outside the allowlist or system coordinates.
The selected display constrains pointer mapping, not the OS keyboard foreground
or application permissions.

The reliable queue holds at most 128 commands. Pointer motion occupies one latest
slot, ordered against reliable events by local enqueue order. Local revoke
discards queued work; worker overflow, injection or cleanup failure closes the worker.
Input older than 100 ms is discarded and interrupts the current input epoch,
retaining consent until a fresh activation. Interruption preserves queued local
status/consent calls while dropping queued input. The native wire sequencer checks network sequence,
epoch and movement barriers before enqueueing input. Queue acceptance and successful `SendInput` submission
do not prove that the target application rendered an action.

An independent native thread pumps hotkeys and system notifications; it never
injects input or waits for the input worker. The input worker checks the two-second
heartbeat deadline without frontend timers. The host does not monitor local input
or idle time: using this computer, including its Weblink window, does not
interrupt remote control or prevent local approval. Explicit revoke and the
emergency hotkey end consent. Cleanup releases presses recorded for the grant,
in reverse order; unmatched remote key/button releases are ignored. Scan-code
input distinguishes extended keys; committed Unicode text is bounded and cannot
be mixed with held remote keys. Pause/PrintScreen are not in the scan-code allowlist.

Display/session notifications, unavailable input desktop, or changed
physical monitor inventory close the worker. Settings notifications recheck the
actual desktop/layout rather than unconditionally closing it. Restart and new consent are required;
unlock never restores a grant. Normal shutdown joins after cleanup. Failed OS
release is reported as failure, not successful revocation; process kill and
unavailable/secure-desktop cleanup are not guaranteed by in-process ownership.
`SendInput` operates within Windows [UIPI limits](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput);
this is not elevated or login-screen control.

Run `cargo run -p weblink-desktop-input --example input_self_test` in an interactive
Windows session. It creates its own test window, requires foreground ownership,
restricts pointer injection to that window's client area, and closes its native
worker before destroying the window. If Windows refuses activation, click the
test window within 30 seconds and leave keyboard/mouse idle during the probe.
The probe checks real window events and cleanup; simulated lifecycle/other-source
input does not substitute for physical-device, lockscreen or crash acceptance.

The desktop library's ignored `browser_pointer_attended` test exchanges SDP/ICE
and test results through `WEBLINK_CONTROL_TEST_DIR` with a browser using the
production `RemotePointer` receiver. Its local test owner approves only the
guarded test session; it does not require physical-click evidence. It is opt-in
and still restricts injection to its own foreground test window.
Set `WEBLINK_CONTROL_TEST_TOUCH=1` for its native touch assertions; the browser
driver must exercise multitouch, movement, lift and cancellation. The receiver
checks `WM_POINTER*` messages and `PT_TOUCH`, not inferred mouse events.

## Windows acceptance

On a Windows device verify install/start/relaunch, About version, room join,
chat, file selection/drop/download, clipboard, camera/microphone and supported
screen sharing. Test denial of media permission, disconnection/reconnection,
minimize/restore, close during media use and starting a second instance. Confirm
that confirming quit exits all application processes and stops active capture, external
links open in the browser, and web PWA updates never replace desktop assets.

Builds, host tests and ordinary Chromium runs do not establish WebView2 media,
GPU capture, remote input or installer acceptance.

References: [Tauri Vite integration](https://v2.tauri.app/start/frontend/vite/),
[capabilities](https://v2.tauri.app/security/capabilities/),
[WebView versions](https://v2.tauri.app/reference/webview-versions/).
