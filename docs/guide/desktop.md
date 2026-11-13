# Install and use the desktop app

The desktop app is for Windows computers that need native screen sharing, incoming remote control, system file actions, or MCP automation. Browsers and desktop clients can join the same room.

To preset your own signaling and web invitation addresses or build an installer from source, see [Tauri deployment](../deployment/tauri.md).

## Download and install {#install}

The supported platform is Windows 10 22H2 / Windows 11 x64, with WebView2 120 or newer.

1. Open the [Weblink download page](https://github.com/99percentpeople/weblink/releases/latest).
2. Choose the Windows installer or portable ZIP.
3. Follow the installer. It installs or updates WebView2 when needed.
4. For the portable version, extract the ZIP before running its executable. Keep the adjacent `weblink-portable` marker and ensure WebView2 is installed.

## Connect for the first time {#first-connection}

Open the app and enter a display name and room ID. Join from another device using the same signaling service, room ID, and password. See [Rooms and chat](rooms.md) for the steps.

For a self-hosted service, enter your signaling address in **Settings → Connection**. Packaged desktop apps should use `wss://` for non-local addresses; local testing can use `ws://127.0.0.1:9000`.

The first connection performs [device pairing](device-trust.md). Remote control and automation require separate authorization; installing the app or entering a room does not enable them automatically.

## Files, windows, and notifications {#daily-use}

- Received files default to a file directory under the application's local data. Choose another directory in **Settings → Transfer → File storage**.
- File menus can open a file in the system's default app, save a copy, or reveal its location. See [File storage and management](storage.md).
- Hiding or minimizing the main window does not leave the room or stop existing sharing. To fully exit, choose Quit from the tray.
- In notification settings, choose categories, sound, and content previews. Windows must also allow Weblink notifications.
- Clicking a system notification returns to the relevant conversation or approval request. Opening a notification does not itself approve remote access.

System notifications require the application to remain running; they do not provide offline message delivery.

## Check for and install updates {#updates}

In **Settings → About**, view the installed version and check for updates manually, or enable automatic checks. Automatic checks announce available versions without downloading or installing them.

For an installed app, follow the confirmation prompts. Installation ends active sessions and restarts the app, so finish transfers and recordings you need to keep first. For a portable app, use the ZIP download link, exit the app, extract the replacement, and keep the portable marker.

## Choose your next step {#troubleshooting}

- **Control this computer from a phone or another device:** set up [remote desktop](remote-control.md).
- **Let an AI client perform authorized actions:** configure [MCP and automation](automation.md).
- **Preset your own service addresses in a desktop package:** follow [Tauri configuration](../deployment/tauri.md#configuration).
- **Fix a blank window or an app that will not start:** check the [desktop runtime requirements](faq.md#desktop-start).
