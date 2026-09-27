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
Windows these include the MSVC C++ build tools, Windows SDK, Rust and WebView2.
The repository pins Rust in `rust-toolchain.toml` and Bun in `package.json`.
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
The Windows workflow builds an unsigned installer as a CI artifact; it does not
publish a release or deploy the website.

Desktop builds use Vite's `desktop` mode and default to `wss://ws.webl.ink`.
Put deployment-specific `VITE_*` / `WEBLINK_*` values in `apps/web/.env.desktop.local`.
Root `WEBLINK_WEBSOCKET_URL` only overrides development, so localhost settings
do not become the packaged signaling endpoint.

## Runtime boundaries

- Desktop version starts at `0.1.0`, independently of the website. Update
  `apps/desktop/package.json` and its Rust crate version together. Tauri reads
  the JS manifest version and Vite uses it for About and `version.json`.
- Desktop builds omit the PWA manifest, service worker, share target and web
  update prompt. Updates currently mean installing a newer desktop package;
  automatic updates need a separate signed release channel.
- The shared `@weblink/platform` contract has browser and desktop adapters.
  `runtime_capabilities` reports Windows native capture support when available;
  remote input remains unavailable.
- Only the local main window can query native capabilities, run capture diagnostics
  and open HTTP(S) or mail links. External links open in the system browser. The window cannot
  navigate to a remote page or create another privileged webview. There are no
  filesystem, shell execution or input-control IPC permissions.
- The main window uses native window controls. Closing it exits the application;
  minimizing keeps sessions alive. A second instance focuses the existing
  window. No tray process, protocol registration or background service is added.
- Files, clipboard and media currently use existing WebView browser APIs. Native
  drag/drop interception is disabled so the app's existing HTML drop handlers
  receive files. File selection/download and media permission prompts must be
  checked in WebView2. Room screen sharing still uses the browser media path.
- IndexedDB and local storage belong to the application WebView profile under
  the OS application-data directory. Browser history is not automatically
  imported; development and packaged origins have separate storage.

## Native capture prototype

On Windows, open **Settings → Advanced → Native screen capture test**, select a
display or window, then start capture. The panel reports frame dimensions, arrival
rate and frame count. It does not preview, record or transmit frames. Static or
minimized sources may deliver fewer frames; the displayed FPS is not an encoder
or network performance measurement.

`crates/desktop-capture` owns Windows Graphics Capture and its worker lifecycle,
independently of Tauri. Frames remain on the native side; no pixel buffers are
mapped to the CPU or serialized over IPC by this prototype. OS cursor/border
defaults are retained. Native encoding, WebRTC transport and remote input are
subsequent steps.

Only one capture runs at a time. Closing the panel, closing the source, or exiting
the application stops it. A 10-second lease also stops capture if the WebView
disappears or stops polling. Session IDs prevent delayed commands from stopping
a newer capture. GPU/startup failures are surfaced and allow retry.

For a native smoke test, run this in an unlocked interactive Windows session:

```sh
cargo run -p weblink-desktop-capture --locked --example self_test
```

It creates and captures its own temporary window, checks frame delivery, resize,
stop/restart and source closure, then removes the window. It does not capture
existing windows or a display.

## Windows acceptance

On a Windows device verify install/start/relaunch, About version, room join,
chat, file selection/drop/download, clipboard, camera/microphone and supported
screen sharing. Test denial of media permission, disconnection/reconnection,
minimize/restore, close during media use and starting a second instance. Confirm
that closing exits all application processes and stops active capture, external
links open in the browser, and web PWA updates never replace desktop assets.

Builds, host tests and ordinary Chromium runs do not establish WebView2 media,
GPU capture, remote input or installer acceptance.

References: [Tauri Vite integration](https://v2.tauri.app/start/frontend/vite/),
[capabilities](https://v2.tauri.app/security/capabilities/),
[WebView versions](https://v2.tauri.app/reference/webview-versions/).
