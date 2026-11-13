# Troubleshooting

Find the symptom you are seeing below. Feature setup belongs in the usage guides; this page covers compatibility limits, connection failures, and recovery steps.

## Browser and runtime compatibility {#browser}

### The page opens, but some actions fail with “is not a function”. Why? {#browser-api}

An older browser can load the page while lacking a JavaScript API used later. Passing the startup compatibility check does not guarantee that every feature works.

| Example console error                                                  | Possible cause in Weblink                                                               |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `findLast is not a function`                                           | The browser lacks `Array.prototype.findLast()`, used in message and attachment handling |
| `Intl.Segmenter is not a constructor` or `Intl.Segmenter` is undefined | The browser lacks the text-segmentation API used for long message previews              |

Update the browser to its current stable version, restart it, and retry. If you opened Weblink inside another app, try the same URL in a standalone browser. On desktop, update the WebView2 runtime too. Changing signaling servers cannot supply a missing browser API.

For the individual API support tables, see MDN’s [findLast](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/findLast#browser_compatibility) and [Intl.Segmenter](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter#browser_compatibility). These tables are not a minimum-version guarantee for all Weblink features. If an updated browser still fails, include its full version and the first console error when [reporting the issue](#report).

### Why are capture or local-directory options missing in this browser? {#capture}

These features have separate API and permission requirements; support for chat or WebRTC alone is not enough.

| Symptom                                                               | What to check                                                                                                               |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Camera or microphone unavailable; `navigator.mediaDevices` is missing | Open the site over HTTPS, or localhost for local testing. Check browser and OS camera/microphone permissions                |
| Screen sharing is unavailable                                         | The browser must expose `getDisplayMedia()`; support varies by browser and platform, especially mobile or embedded browsers |
| No local-directory storage option                                     | The browser must expose `showDirectoryPicker()` in a secure context. Otherwise, use browser storage and Save to device      |

See MDN’s requirements for [camera and microphone capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia), [screen capture](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia), and [directory selection](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker).

An HTTP page on a LAN IP is not equivalent to localhost. Retrying permissions cannot add an API the browser does not implement. Try a current desktop browser or use the Windows desktop app for native screen sharing.

### Why is the desktop window blank or unable to start? {#desktop-start}

Check the [desktop installation requirements](desktop.md#install): Windows 10 22H2 / Windows 11 x64 and WebView2 120 or newer. Use an up-to-date WebView2 runtime; the listed minimum is not a guarantee of every media capability.

The installer installs or updates WebView2 when needed. A portable or standalone executable needs it already installed; extract the portable ZIP before launching. If the problem persists, report the Weblink version, Windows version, WebView2 version, and startup error. For JavaScript errors after startup, follow the [browser API checks](#browser-api).

## Signaling and network connections {#connection}

### Why is joining slow or impossible from mainland China? {#signaling-mainland}

The default signaling address is `wss://ws.webl.ink`. From some mainland China networks, a signaling endpoint may connect slowly, time out, or repeatedly reconnect. Reachability depends on the endpoint, carrier, DNS, and network route; availability on one network does not establish availability on another.

1. Check the actual address in **Settings → Connection → WebSocket signaling server**. A saved custom address overrides the site or package default.
2. On the affected device, compare the same endpoint over another network, such as Wi-Fi and mobile data. Record whether the failure is DNS resolution, TLS, or the WebSocket handshake using the [checks below](#signaling-unreachable).
3. If that endpoint remains unreachable, choose a signaling service reachable by **all** participating devices, or deploy your own [Server](../deployment/backend.md) or [Worker](../deployment/worker.md). A Worker or custom domain alone does not guarantee mainland reachability; verify it from the networks you intend to use.
4. Set the same signaling address on every device and rejoin the room. Matching room IDs on different signaling servers do not put devices in the same room.

Signaling handles room discovery and connection negotiation. Messages, files, and media travel over WebRTC, directly or through TURN. Once members are visible, a transfer or video failure needs [WebRTC connection checks](#peer-connection); a different signaling domain does not automatically improve that data path.

### The website loads, but WebSocket keeps failing. How do I locate the failure? {#signaling-unreachable}

The website and signaling service can be hosted separately. Open browser developer tools → **Network → WS**, then rejoin the room and inspect the actual request.

| Observation                                                       | Likely check or next action                                                                                   |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| DNS resolution fails                                              | Check the signaling hostname and DNS/network access from this device                                          |
| Certificate or mixed-content error                                | Use a valid `wss://` endpoint for an HTTPS site; check the certificate, hostname, and device clock            |
| Handshake times out or the connection is refused                  | Check service availability, port/firewall access, and whether the current network or proxy permits WebSockets |
| The WebSocket request returns an HTTP error instead of connecting | Check the URL path, reverse-proxy WebSocket upgrade forwarding, and backend logs                              |
| The socket connects but the other device is absent                | Compare the full signaling endpoint, room ID, password, and online status on both devices                     |

For self-hosted Server or Worker, `https://signal.example.com/healthcheck` tests HTTP reachability if that route is exposed. A 200 response does not verify the WebSocket upgrade or a peer connection. Conversely, opening the signaling root in the address bar can return 400 or 426 because an ordinary navigation is not a WebSocket handshake.

Use the exact reachable endpoint, including any configured path. Another device cannot reach your server through its own `localhost`, or through a Docker-internal service name. Packaged desktop clients also require WSS for non-loopback hosts, including LAN hosts. See [Server reverse-proxy configuration](../deployment/backend.md#tls-and-proxy).

If a rebuilt client still contacts the old endpoint, update or reset its saved connection setting and rejoin. Frontend defaults are embedded at build time; changing environment variables on a running static-file container does not rebuild them.

### Members appear, but messages, files, or video still cannot connect. Why? {#peer-connection}

Member discovery confirms signaling progress, not a working WebRTC data path.

1. Check [pairing and device permissions](device-trust.md#pairing). An identity warning or denied permission requires its own action.
2. In **Settings → Connection**, check STUN/TURN availability from both networks. A signaling Server or Worker is not a TURN relay.
3. If relay-only mode is enabled, a reachable TURN service with valid credentials is required. Without one, turn that mode off and reconnect to allow direct connections.
4. Compare another network. If a firewall or NAT prevents direct connectivity, configure a TURN service reachable from both devices; replacing the WS address alone does not provide relaying.

If messages or files already work and only video fails, continue with [codec and video checks](#media). For slow transfers, compare a [connection speed test](connection.md#speed-test) with actual saving: disk writes, compression, concurrent tasks, and device load are not measured by the network test.

### Why does the TURN credential request return 503, 502, or 504? {#turn-credentials}

These responses refer to `/turn-credentials`, not the WebSocket connection itself:

| Status | Meaning and action                                                                                                                |
| ------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 503    | Managed TURN is unconfigured. The service operator must set both `TURN_KEY_ID` and `TURN_KEY_API_TOKEN`, then restart or redeploy |
| 502    | The backend failed to obtain credentials from the upstream service; check the backend error and upstream access                   |
| 504    | The upstream request timed out; check backend-to-provider connectivity and retry                                                  |

Signaling can work without managed TURN, but a network requiring a relay still needs another working TURN configuration. Keep provider keys on the backend. If WebSockets use `/ws`, the credential endpoint still belongs at `/turn-credentials` on the same origin; the included Nginx template only proxies `/ws` by default. See [Server TURN](../deployment/backend.md#turn) or [Worker TURN](../deployment/worker.md#turn).

## Audio, video, and recording {#media}

### Why does H.265 work in Chrome but fail when Edge sends or receives? {#hevc-browsers}

**WebRTC sending/encoding, receiving/decoding, and file playback are different capabilities.** For the Chromium-based desktop browsers discussed here, the known default WebRTC support is:

| Browser        | Send H.265 / HEVC                                                         | Receive H.265 / HEVC                                                                             |
| -------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Chrome         | Supported from Chrome 136 when the platform exposes a usable HEVC encoder | Supported from Chrome 136 when the platform exposes a usable HEVC decoder                        |
| Microsoft Edge | Currently not supported by default                                        | Currently not supported by default; an H.265-only video offer can be rejected during negotiation |

Chrome's introduction is documented in the [Chrome 136 release notes](https://developer.chrome.com/release-notes/136#h265_hevc_codec_support_in_webrtc); its [WebRTC implementation announcement](https://groups.google.com/a/chromium.org/g/blink-dev/c/3h8lL8a377c) explains the platform requirement. A May 2026 [Microsoft Q&A support reply](https://learn.microsoft.com/en-us/answers/questions/5880331/h-265-hevc-not-published-sent-via-webrtc-chrome-su) describes the missing default send and receive support in Edge. Sources checked on **2026-11-12**; a later browser release may change this.

This also affects **Edge as a viewer**. A Chrome or native desktop sender using H.265 does not make Edge able to receive it. Negotiation can reject the video without immediately throwing a browser JavaScript exception; Weblink's screen-sharing receiver treats that rejection as an unsupported video format.

If either side uses Edge, select **Automatic** or an available H.264 option on the **sending device**, then restart sharing. Automatic mode considers the connected receivers' capabilities. To use H.265, both the sender and the receiver must expose the corresponding WebRTC capability. These desktop Chrome facts do not establish support for Chrome on iOS or every Chromium-based browser.

Edge's ability to play an HEVC file, or support HEVC through another media API, does not prove WebRTC sending or receiving support. Windows HEVC playback has its own [decoder requirements](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/video-playback-issues); installing a playback decoder is not a documented fix for Edge's missing default WebRTC H.265 support.

### Why is H.265 unavailable or unused even in an updated Chrome? {#hevc-unavailable}

The browser version is only one requirement. Check whether the current OS, GPU, driver, and browser hardware-acceleration configuration expose an HEVC encoder. Chrome’s `chrome://gpu` page can help inspect acceleration status, but a hardware entry alone does not prove successful WebRTC negotiation.

Weblink considers local encoding capabilities and the connected devices’ decoding capabilities. Automatic mode prefers a common format; choices can change as devices join or leave. A manually selected codec is a negotiation preference, not a guarantee that every peer will use it.

Use Automatic first, or H.264 for a compatibility check, then restart sharing. If H.265 is required, check both the sender and receiver rather than only the sender’s settings. Tauri native screen sharing uses its own reported native encoders; do not apply Edge’s browser limitation to that path.

### Picture works, but why is there no sound? {#no-audio}

1. Check the intended source. Microphone sound requires capture permission, the correct input device, and an unmuted sender. Screen sound requires an audio track from the selected sharing source; sharing video alone does not add it.
2. On the receiving device, enable listening and unmute the relevant member or source. Also check site/tab mute, the operating system's app volume, and the actual headphone or speaker output.
3. Use the app's listening action explicitly. Browser autoplay can block the audio player; Windows native reception also needs its Web Audio playback context to run.
4. If the chosen output was disconnected or is unavailable, choose an available output when supported, or return to the system default.
5. On Windows, suppressing local playback during native system-audio sharing mutes active playback endpoints while capture continues. If local listening is required, disable that option and restart system-audio sharing.
6. If sound stopped after manually choosing an audio codec, return to Automatic and restart the affected source.

Video decoding and sound playback are separate checks. The [audio path article](../architecture/audio.md) explains capture, decoding, and local playback boundaries; if all peer traffic fails, use [connection troubleshooting](#peer-connection).

### The connection works, but video is black, audio-only, or stuttering. What should I try? {#video}

1. Check whether the sender’s local preview is normal. If it is already black, reselect the capture source and check [capture permissions](#capture).
2. Restart sharing with Automatic or H.264 when available. If that fixes the picture, investigate the previously selected codec and the receiver’s decoding support, especially H.265.
3. Lower resolution, frame rate, and bitrate. Check device load and the [current connection speed](connection.md#speed-test); a congested direct or TURN path can cause stuttering.
4. If only one viewer fails, compare that viewer’s browser, version, GPU/driver, network, and receive-quality settings with a working viewer.

A normal local preview does not prove the remote device can decode the transmitted stream. If no peer data connects at all, return to [connection troubleshooting](#peer-connection).

### A recording saved successfully, but why will it not play? {#recording-playback}

First confirm the file finished saving. A recording interrupted by refresh, a crash, or an incomplete transfer may be unfinished; pausing is not the same as stopping and finalizing it.

For a completed file, the player must support both its container and its video/audio codecs. **MP4 does not necessarily mean H.264**: Weblink can preserve H.265 in an MP4 recording. Selecting a container or renaming the extension does not guarantee conversion to another codec.

Try a player that supports the actual codecs. For future recordings that need broader playback support, use H.264 at the source when available and verify a short recording on the intended player. See [recording formats](media.md#recording); HEVC playback in Edge depends on its [Windows decoder path](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/video-playback-issues).

## File access and saving {#files}

### Why did a previously available file become unreadable? {#file-unavailable}

For directory-backed files, check whether the original was moved, edited, or deleted, whether the drive is connected, and whether the browser needs directory authorization again. Restore [directory access](storage.md#change-directory) before retrying. Send an edited file again rather than expecting an old attachment to refer to new content.

For browser-stored files, confirm you are using the original site and browser profile. Clearing site data can remove the stored content; it cannot repair a missing file. An attachment entry alone does not guarantee that its source bytes are still available.

### Why does receiving or recording fail while saving? {#storage-full}

Check the storage location, available disk space or browser quota, and directory write permission. A successful network transfer does not prove that the destination can finish writing.

Save files you need to keep to the device before removing unwanted content. If the browser supports it, choose a writable local directory for **new** tasks; changing the default does not relocate an active task. Do not clear all site data as a routine retry, because it also contains history and settings. See [storage cleanup](storage.md#cleanup).

## MCP connection errors {#mcp}

### Why does the MCP client report connection refused? {#mcp-connection}

On desktop, confirm that **Enable MCP** is on and the endpoint is running. Compare the client URL with the active address displayed by Weblink; check port conflicts and, for LAN access, firewall and listening-interface settings. `127.0.0.1` always points to the computer running the MCP client.

After changing the listener address, turn MCP off and on and update the client configuration. Enabling automation alone does not start the listener. Browsers use WebMCP rather than a local HTTP endpoint. See [MCP connection setup](automation.md#quick-start).

### Why is MCP authentication rejected? {#mcp-auth}

Check that the client sends the generated Authorization header to the correct desktop endpoint. The token must belong to that endpoint and must not be expired or revoked. If the full token was lost, create a replacement and update the client; existing token summaries cannot recover it.

If authentication succeeds but a tool returns `DISABLED` or needs remote approval, follow the [automation switches](automation.md#switches) and [destination permissions](automation.md#permissions). Those are separate from token authentication.

## Report a problem {#report}

Report reproducible problems in [GitHub Issues](https://github.com/99percentpeople/weblink/issues). Include the steps, expected and actual behavior, Weblink version, full browser/WebView2 version, and OS version.

For connection failures, include the signaling hostname/path, affected region and carrier/network type, time of failure, and whether the failure occurs at DNS, TLS, WebSocket, or peer connection. For video, include both devices’ versions, sending/receiving direction, selected codec, GPU/driver if relevant, and whether Automatic or H.264 works.

Remove room passwords, MCP tokens, TURN credentials, and private network details from logs before sharing. For file problems, describe the storage type and failing stage without uploading private files.

## Choose your next step {#next-steps}

- **Connect your devices again after resolving the failure:** return to [connecting two devices](../index.md#connect-two-devices).
- **Replace an unreachable signaling endpoint or configure a relay:** use [connection settings](connection.md).
- **Adjust capture, encoding, or recording settings:** follow [audio, video, and recording](media.md).
- **Run a signaling service you can verify from your users’ networks:** choose [Server deployment](../deployment/backend.md) or [Worker deployment](../deployment/worker.md).
