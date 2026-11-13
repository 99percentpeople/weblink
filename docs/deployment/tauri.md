# Tauri deployment

Deploy the Windows desktop client to computers that need native screen sharing, remote control, file access, or MCP automation. The supported platform is Windows 10 22H2 / Windows 11 x64 with WebView2 120 or newer.

The app embeds its frontend. Each computer runs its own client and connects to a signaling backend; you do not host the desktop files on a web server. Deploy either [Server](backend.md) or [Worker](worker.md) first. If you also need browser access and web invitation links, follow [Web deployment](hosting.md).

## Use an existing desktop package {#existing-package}

If you only want to connect to your own backend, use the existing app:

1. Download the installer or portable ZIP from [Weblink releases](https://github.com/99percentpeople/weblink/releases/latest).
2. Run the installer, which installs WebView2 when needed. For the portable ZIP, extract all files, keep `weblink-portable` beside the executable, and install WebView2 yourself if it is missing.
3. Open **Settings → Connection → WebSocket signaling server**, enter your address, such as `wss://signal.example.com`, and save it.
4. Join the same room from another client using the same signaling service, room ID, and password.

Changing the signaling setting does not change the packaged default for web invitation links. To embed your own signaling and public web addresses as defaults, build a package as described below. Daily operation and updates are covered in [Desktop app](../guide/desktop.md).

## Prepare a Windows build environment {#requirements}

Use a Windows x64 machine and install:

- Git and Bun, using the Bun version in the root `package.json` `packageManager` field.
- Rust through rustup. The repository's `rust-toolchain.toml` selects the required toolchain.
- Visual Studio C++ Build Tools with the **Desktop development with C++** workload, MSVC 14.44 (Visual Studio 2022 17.14) or newer, and Windows SDK 10.0.26100 or newer.
- WebView2 120 or newer. See the [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/#windows) for installation instructions.

**Source builds currently require read access to the private native SDK repository used by the pinned Cargo dependencies.** Git must be able to fetch those dependencies, and the initial native WebRTC download also requires an authenticated GitHub CLI (`gh`). A public source checkout alone is not enough to build the desktop executable. Without SDK access, use the existing package above; Web, Server, and Worker deployment do not require that SDK.

After installing the tools and arranging SDK access, run these commands in PowerShell:

```powershell
gh auth login
gh auth setup-git
git clone --recurse-submodules https://github.com/99percentpeople/weblink.git
cd weblink
bun install --frozen-lockfile
rustup show
rustup target add x86_64-pc-windows-msvc
```

For an existing checkout, run `git submodule update --init --recursive` and `bun install --frozen-lockfile` from the repository root. Run the remaining commands from that root too. The first native build downloads dependencies and can take longer than later builds.

## Configure the packaged client {#configuration}

Create a desktop-specific environment file:

```powershell
Copy-Item apps/web/.env.example apps/web/.env.desktop.local
```

Edit `apps/web/.env.desktop.local`, replacing the example domains:

```dotenv
VITE_WEBSOCKET_URL=wss://signal.example.com
VITE_SHARE_URL=https://web.example.com
WEBLINK_STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
```

| Setting                | Purpose                                                                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `VITE_WEBSOCKET_URL`   | Default signaling address. Packaged clients require `wss://` for non-loopback hosts; `ws://127.0.0.1:9000` is allowed for testing on the same machine              |
| `VITE_SHARE_URL`       | Public Web frontend used in room invitation links and QR codes. Deploy that site separately; this does not change the app's embedded frontend or signaling address |
| `WEBLINK_STUN_SERVERS` | Comma-separated STUN addresses                                                                                                                                     |
| `VITE_TURN_SERVERS`    | Optional custom TURN relays, using the format in [STUN and TURN](hosting.md#stun-and-turn)                                                                         |

Tauri builds use Vite's `desktop` mode. The commands below explicitly load the desktop file with Bun's `--env-file` option so an existing `apps/web/.env.local` does not supply an unintended Web default. Existing process environment variables still take precedence. The root `.env` is for combined local development and does not configure a packaged client.

These values are embedded **at build time**. Changing them requires rebuilding and reinstalling the package. A user's saved connection settings override the packaged defaults; use Reset in the corresponding setting to use the new default.

Client configuration is visible in the built app. Configure `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` only on the [Server](backend.md#turn) or [Worker](worker.md#turn). The client obtains temporary credentials from that backend automatically.

## Build an installer or executable {#build}

To build the Windows x64 NSIS installer:

```powershell
bun --env-file=apps/web/.env.desktop.local run build:desktop --target x86_64-pc-windows-msvc --bundles nsis
```

The command builds the desktop frontend and then the native app. With the default output settings, find:

| Output                  | Location                                                    |
| ----------------------- | ----------------------------------------------------------- |
| Installer               | `target/x86_64-pc-windows-msvc/release/bundle/nsis/`        |
| Application executable  | `target/x86_64-pc-windows-msvc/release/weblink-desktop.exe` |
| Embedded frontend build | `apps/desktop/dist/`                                        |

Alternatively, supply defaults directly as build environment variables:

```powershell
$env:VITE_WEBSOCKET_URL = "wss://signal.example.com"
$env:VITE_SHARE_URL = "https://web.example.com"
bun run build:desktop --target x86_64-pc-windows-msvc --bundles nsis
```

To generate only the executable, without an installer:

```powershell
bun --env-file=apps/web/.env.desktop.local run build:desktop --target x86_64-pc-windows-msvc --no-bundle
```

The executable is in the same release directory. A target computer running it directly needs WebView2 installed. Installing a desktop package does not start a signaling server; keep your Server or Worker available separately.

## Install, launch, and verify {#verify}

1. Copy the generated installer to the target Windows computer, run it, and launch Weblink from the Start menu. For a standalone executable, copy it to a local directory and run it there.
2. Check the signaling address in **Settings → Connection**. Reset any old saved override if it should use your new packaged default.
3. Join from a browser or another desktop using the same backend and room credentials. Check messages, file transfers, and reconnection.
4. Open a room invitation or QR code and confirm it uses your `VITE_SHARE_URL` Web deployment and connects to the same backend.
5. If needed, configure and authorize [remote desktop](../guide/remote-control.md) or [MCP automation](../guide/automation.md) separately.

Closing or minimizing the window can leave the app running in the tray; choose Quit there to stop it completely. To update a custom package while keeping your build defaults, rebuild with your configuration, exit the old app, and install the replacement. The built-in release check points to official Weblink downloads; environment variables do not create a separate update service.

## Choose your next step {#troubleshooting}

- **Use the installed app for files, notifications, and updates:** continue with the [desktop guide](../guide/desktop.md).
- **Provide your own website for invitation links:** follow [Web deployment](hosting.md) to build that browser entry point.
- **The app is installed but shows a blank window or will not start:** check the [desktop runtime requirements](../guide/faq.md#desktop-start).
- **The app starts but cannot reach your service:** follow the [WebSocket connection checks](../guide/faq.md#signaling-unreachable).
