# Automation: WebMCP and MCP

Weblink exposes a shared tool catalog through browser WebMCP and a native MCP
server. **Settings → Automation** has two independent switches on desktop:

- **Enable automation** permits MCP clients and authorized remote devices to
  operate this computer. It does not start the MCP API.
- **Enable MCP** starts the MCP API. With local automation off, clients can still
  use `devices.list`, local diagnostics and forward calls to directly connected
  devices. Other local tools return `DISABLED`. Incoming OS automation calls
  require local automation, plus the existing destination-device permissions.

Stream diagnostics are available by default on both desktops and browsers,
independently of either switch or browser WebMCP support. Paired devices can call
`diagnostics.snapshot`, `history`, `export`, `start` and `stop` through the existing
`automation/1` channel. The receiving client's **Reading and diagnostics** policy
still controls access: Ask uses a session approval; Always allow and Deny remain
saved per device. Trust, content reception and connection generation checks apply.
The additive `automation/1.diagnostics` flag advertises this ability without
changing the shared protocol version.

Browsers expose only **Enable MCP** for WebMCP registration. They accept incoming
diagnostic calls, with the same device permissions and notification approvals as
desktop, and reject all incoming OS automation and forwarding. A browser's local
WebMCP client can read its own diagnostics without peer approval.

Both switches start disabled and persist independently.
Native startup waits for its authority channel before restoring each switch.
A failed MCP bind reports the error without clearing the saved preference or
stopping local automation. Disabling automation cancels local OS automation calls,
approvals, command jobs and input leases while keeping diagnostics and MCP
forwarding alive. Disabling MCP
cancels token calls and stops its listener while retaining incoming peer authority.
The diagnostic peer channel remains available while the application is running.
The HTTP MCP listener and browser tool registration still follow the MCP switch.

## Quick start

### Desktop MCP client

1. Open **Settings → Automation** on a Windows desktop and enable **MCP**.
2. Under **Local MCP tokens**, create a named token for the client and choose
   its expiry. Copy its secret or connection configuration from the creation
   dialog; the full secret is shown only once.
3. Configure the MCP client with the generated URL and Authorization header.
   A server entry using the default listener looks like this (the client's
   enclosing configuration format may differ):

   ```json
   {
     "url": "http://127.0.0.1:32100/mcp",
     "headers": {
       "Authorization": "Bearer <YOUR_MCP_TOKEN>"
     }
   }
   ```

4. Enable **automation** on this desktop if the client should use its local OS
   tools. Discovery, diagnostics and forwarding work with automation off.
   Enabling MCP alone does not allow local OS control.
5. Ask the client to list devices. Every tool takes an explicit `target`:

   ```json
   {
     "name": "devices.list",
     "arguments": { "target": "local" }
   }
   ```

To operate a remote desktop, connect both Weblink devices in the same room and
complete [device pairing](DEVICE_TRUST.md). For OS tools, enable automation on the destination,
then use its ID from `devices.list` as the tool's `target`. Its device settings
decide whether Reading and diagnostics, Sharing and control, or Terminal and
commands require approval. A notification approval lasts for that connection;
Always allow and Deny remain saved policies. The destination does not need to
expose its own HTTP MCP API for peer calls.

For pointer or keyboard input, start a native monitor stream with `screen.start`
and acquire it with `control.acquire`. Input then operates the current desktop;
`control.bindWindow` is optional. Screenshots can inspect an entire source, a
window or a rectangle; use the returned image-to-desktop transform for pointer
coordinates. Query `commands.capabilities` before choosing Shell signals.

### Browser WebMCP client

In a browser that provides `document.modelContext`, enable **MCP** in Automation
settings, connect to a paired desktop with automation enabled, and use that
desktop's ID as the target. For diagnostics only, the destination can also be a
browser and needs neither automation nor MCP enabled. The browser registers the shared tools with WebMCP;
it does not start an HTTP listener, issue local tokens, or execute OS input and
Shell jobs locally. The switch is unavailable when the browser lacks WebMCP.

## Connecting

A supporting browser uses the [WebMCP `document.modelContext` API](https://webmachinelearning.github.io/webmcp/). The switch
stays off and disabled when WebMCP is unavailable, without erasing the saved
preference. MCP becomes active only after tool registration succeeds;
registration failure, disabling MCP or closing the page aborts the
registrations. The browser has no local token management. Its device permission
settings and notification approvals authorize incoming diagnostic requests even
without WebMCP. OS input and Shell execution require a desktop target.

On desktop, create one MCP credential per client in Automation settings. Copy
the displayed Streamable HTTP URL and Authorization header into the client's
MCP configuration. Generated configurations send the token directly as
`Authorization: sk-...`; `Authorization: Bearer <token>` is also accepted.
Both header forms enforce the same expiry, revocation,
Host and Origin checks. The **MCP server** settings configure the listening host and
port. Text fields save automatically on blur, including while MCP is running.
Listener changes take effect the next time MCP is enabled, preserving
the current endpoint, calls and grants until then. The UI distinguishes the
active URL from pending settings. The default host is `127.0.0.1`; `localhost`,
IPv4 and IPv6 literals are accepted. `0.0.0.0` and `::` explicitly enable listening
on all interfaces. The connection addresses list includes the local loopback URL
and the active network interfaces' concrete IP URLs for the listener's address
family, each with its port and `/mcp` path. It refreshes as network interfaces
change; pending host/port edits do not alter this list until the listener restarts.
Clients on another computer use the desktop's reachable network IP instead of
the loopback URL. IPv6 link-local addresses are omitted because their interface
scope depends on the connecting computer. Token creation keeps the local URL
as its default; remote clients substitute an address from the connection list.
The service uses HTTP, without TLS termination or DNS hostname aliases.
The default port is `32100`; valid ports range from 1 to 65535. Port `0` is
rejected. Restore defaults resets the listener to `127.0.0.1:32100`, using the
same deferred application path. Host and port persist across restarts.
A port conflict is an explicit startup error; it never silently changes a saved
port. Changing the endpoint preserves tokens, but clients must update their URL.

The desktop-only **Local MCP tokens** list supports named tokens, an expiration
time (including custom dates), no expiration, editing and revocation. Creation
and editing use child dialogs; existing token settings save automatically, while
creation remains an explicit action that generates a new credential. Restoring
the default validity sets a 30-day deadline without changing the token name or
secret. The compact list shows token summaries and actions. The full
random token is displayed only at creation. Tokens use `sk-` followed by
43 unpadded Base64url characters encoding 32 bytes from the OS secure random
source (46 characters total). Only a SHA-256 hash, a short display prefix,
name, creation time and expiration are stored alongside the desired Host/port in
the current WebView's `localStorage` entry `mcp_registry`. The native service
validates a proposed change; the renderer saves that record before native
activation and serializes edits to prevent lost updates. A storage failure does
not activate the change. If activation fails after saving, the page's automation
session closes and the saved record is restored on the next open.
Clearing this storage resets MCP credentials and listener settings on the next open. The
list, creation, editing and revocation remain available while MCP is disabled.
Issuing a token authorizes discovery, diagnostics and forwarding, plus local OS
tool calls when automation is enabled, without additional local approval, but
never starts the listener;
its connection configuration uses the saved endpoint when the server is off. Tokens survive disabling/restarting, while
runtime grants and pending calls do not. Expired tokens remain visible and can
be renewed or revoked. Every HTTP request and final native effect checks token
validity. Expiry/revocation cancels the token's grants and native tasks. Renewing
an already expired token authorizes new calls; it cannot revive old grants
or pending calls, including between background cleanup ticks.

These tokens authenticate local MCP clients only. They do not pair remote
devices, appear in remote-device permission lists, or authorize a remote device.
A valid token needs no extra local approval to connect to another client.
Local OS tool calls also require the automation switch; `devices.list` and the
five diagnostic tools do not.
The destination still enforces its own device permissions. Requests require
the accepted socket's concrete IP and port in Host, including on wildcard
listeners; arbitrary DNS names and forwarded headers never authorize a request.
A present Origin must match that HTTP origin. Browser cross-origin HTTP
requests are not enabled.

The server uses the official Rust `rmcp` SDK for protocol negotiation and
transport handling, including legacy negotiation supported by that SDK. Tool
results are structured objects with a JSON text representation; native screenshots
return their PNG only as MCP image content, with image metadata in the JSON results. No MCP credentials are sent to peers. HTTP authorization is tied to the client
credential and grant lifetime, not individual TCP connections: modern MCP HTTP
is stateless. Cancelling an HTTP call cancels that invocation.

Native source discovery and screenshots do not hold the permission lock while
waiting for the OS. Token, grant and request validity are checked again before
returning data; cancellation or revocation discards a late result. One native
read may run at a time (`BUSY` for overlapping reads), and cancelling a caller
does not release that slot until the OS operation returns. MCP management and
permission cleanup run off the window thread so native window message handling
remains available during lock and worker waits.

Every tool requires an explicit `target`: `local` or a directly connected
Weblink peer ID. `devices.list` discovers available peers. Remote calls use a
`automation/1` capability and ordered WebRTC DataChannel. Existing
clients without that capability cannot call tools. All peer application traffic
also requires [device pairing and content permission](DEVICE_TRUST.md).

Automation connections follow the shared peer capability notifications and
message-channel lifecycle events; they do not poll connected devices. Both peers
must allow receiving content before opening the channel. Revoking that permission
closes it, and a new permission announcement allows reconnection. Only open
automation channels appear in the connected automation device list. An
established channel can recover on its close event; a failed channel open waits
for another capability or channel-readiness notification instead of retrying in
a loop. Native input renewal and cancellation checks run independently of peer
discovery and renderer timers.

## Consent and identity

Identity and authorization remain device-local. Each destination device manages
its own trust and permissions; access is not inherited from a shared user account
or another device. Local MCP client tokens and remote-device identities remain
separate credentials. SSO, identity federation and organization-wide policy are
outside the current scope. Device pairing and proof of key possession do not
require those enterprise features.

The desktop MCP entrypoint authenticates its token and checks its lifetime on
every call. Issuing the token supplies the client authorization; the automation
switch gates `target:"local"` calls except `devices.list`. Forwarding to other clients needs no further approval on the
entrypoint. WebMCP also forwards without a browser approval. The destination
desktop enforces its own peer permissions independently; an MCP source label or
the controller's token never bypasses its Ask, Always allow or Deny policies.
Permissions are presented as three independent groups:

- **Reading and diagnostics**: device/stream state, screenshots and accessibility tree content.
- **Sharing and control**: screen sharing, stream configuration, keyboard/mouse and semantic accessibility actions.
- **Terminal and commands**: Shell execution, output and task management.

`packages/automation/src/permission-groups.json` defines these groups for both
TS and Rust. Selecting a group decision updates its member scopes together;
native execution still checks the specific tool's required scope.
Remote automation permissions live in each device's permission dialog (both the
client details and Settings → Clients and rooms). Each group supports **Ask**,
**Always allow**, and **Deny**, with Ask as the default. These policies persist in
that device's local permission record and are applied only to a currently paired,
verified peer channel. A signaling ID or reported caller name never supplies
this authority. Losing trust resets all scopes to Deny; ordinary disconnection
and automatic key repair retain the saved policy. The content reception and
screen sharing switches remain prerequisite gates.

Device permission pages contain only the saved policy controls, without request
or active-grant lists. Ask requests use the shared control-request notification
service: an actionable in-app notification while visible, or a system notification
while in the background when enabled. Opening the system notification displays
the same in-app approval without granting access. Both surfaces offer Allow for
this session or Deny, without a duration selector. The in-app split button also
offers **Always allow** and **Always deny**. These choices save the requesting
device's policy for the displayed permission group and settle the current request
in the same decision. Other devices and permission groups are unchanged. The in-app review
includes the permission description, tool arguments, reported source and configured
host emergency stop shortcut. System previews omit tool arguments and respect the
notification preview preference. Resolved requests dismiss their notifications;
expired, disconnected or unverified requests cannot be approved from stale actions.
If a system-notification answer fails while its request remains pending, the
foreground approval remains available for an explicit retry; native callbacks
are never replayed.
Local MCP tokens remain under Automation and do not prompt for peer consent.
Session-only peer approvals last until the current connection ends and do not change saved policies. They
bind a caller identity, target, permission group and current connection lifetime.
Consent resolves concurrent requests in that same group only. Explicit
Deny decisions remain excluded from the grant. Changing a device's permission
setting invalidates affected grants immediately; emergency stop remains the shared
way to end current access without changing saved settings. Native execution still
checks the exact tool scope. Existing
remote-control allowlists do not grant automation permissions. In the existing
remote-device permissions screen, **Always allow** is a persistent remote-control
policy with no expiry. It is separate from MCP tokens and automation scope grants.
Native control snapshots identify whether the active grant came from remote
control or automation. Device remote-control policy applies only to remote-control
grants; automation grants retain their own scope checks and the shared local stop.
The host header shows the active automation input lease, including local MCP control
outside a room, without displaying token names. Permission alone does not show an active
controller. Released or invalidated leases disappear on the next status refresh;
borrowing an existing remote-control grant keeps a single controller indicator.
The controller header shows each controlled device by name with a sparkle pointer.
The recipient-specific `automation.controlActive` capability reports only that peer's
live input lease on the current connection; clients without this optional field do
not advertise an outgoing automation status. Stopping it releases that lease without
changing token permissions or disabling automation.
When the same verified device already controls the requested monitor,
`control.acquire` borrows that manual grant instead of replacing it and returns
`reused: true`. Both the device ID and shared connection generation must match,
as must the capture, source and geometry. Automation permissions are still checked
independently. Local MCP token identities cannot borrow another device's grant.
The native snapshot continues to report the manual controller; its media and
input channels remain open. Repeated acquisition is idempotent. Borrowed leases
have separate IDs, held-input ownership and optional window confinement.
Release, cancellation and window-focus failure clear only the borrowed lease and
its held inputs. A human's held modifiers/buttons block automated input rather
than becoming part of it. Manual input pauses while an automated gesture holds
keys/buttons. Native interruption, grant revocation, media teardown and connection
replacement invalidate the borrowed lease; stale cleanup cannot release a new one.
The policy remains indexed by client ID, but is effective only after the peer
proves its paired device key. Failed device verification resets it to deny.
Automatic pairing-key repair/renewal preserves saved permissions. First pairing
and explicit re-pairing restore default device permissions, including Ask for
automation; previous permanent grants are not restored.

Automation reuses the existing paired-device authentication and the ordered,
DTLS-protected WebRTC connection. It has no additional handshake, key, comparison
code or device-identity mapping. The native peer authority uses the verified device
ID and the shared capability connection generation for calls, policy updates and
disconnect cleanup. Resetting the main transport replaces that generation; old
requests and cleanup cannot affect the replacement connection. Reopening an
automation channel within the same connection waits for its predecessor's cleanup.
Temporary grants end with the channel; Always allow is reapplied only after shared
device verification and reception permission checks.

The shared protocol registry advertises `automation/1`. Messages retain sequence validation,
bounded framing and receive queues, duplicate request rejection and at most four
concurrent calls. The receiver accepts only its direct paired peer; a call cannot
route a second hop. Browser Agent names and source labels are informational and
never authorize access. Browser WebMCP only controls destinations and records a
bounded local audit; permission decisions remain in the destination's native
authority. Local MCP clients continue to authenticate with their existing tokens.

Incomplete frame assemblies expire after 30 seconds even if the sender goes silent.

Native operations require a single-use Rust ticket bound to an approved request.
No approval or policy-editing tool is registered. Only the main bundled UI may
approve pending requests. The Rust authority rechecks grants before native side
effects and before delivering results. Application-side tools recheck their ticket
around asynchronous work, and native cancellation immediately notifies the UI to
abort active operations. A stream created during revoked screen-start work is
disposed before publication. Duplicate requests and late cleanup cannot cancel a
new request with the same ID. Cancelling a request while it awaits consent returns
and records `CANCELLED`; an explicit denial returns `PERMISSION_DENIED`.
Automation authority lasts for the native page session, like remote control.
Switching Weblink to the background, minimizing it or hiding it in the tray keeps
permissions and input leases alive. Native input renewal runs independently of
renderer timers; a delayed UI status refresh does not end the session. Reloading
the page, destroying the main window or exiting revokes the old authority and
cancels its work. Token/approval expiry, disconnection and explicit revocation
still end their respective permissions. An explicitly bound target window losing
focus still releases its held input and ends that input lease.

Use the existing **Host emergency stop shortcut** on Windows to stop both remote
control and automation, including when no control lease is active. The same native
listener respects the configured shortcut and works while the app is in the background.
It fences new calls immediately, revokes grants, cancels pending reviews, queued work
and command process trees, and releases automated input. The tray's local revoke
action uses the same stop path; automation settings have no separate stop button.
Emergency stop and explicit revocation of a policy grant pause token calls and automatic Always-allow grants
until their respective switch is disabled and enabled again: MCP resumes token
calls, while automation resumes remote-device Always-allow policies. Each switch
leaves the other pause intact. This pause does not erase saved policies;
individual timed peer approvals remain available. Window focus loss, capture end,
input interruption and held-input timeout only end the affected input lease and
release its held keys/buttons; they do not pause automation permissions or unrelated
command jobs. Reacquiring control still requires a current capture and valid permission.
Late input cleanup cannot suppress an emergency stop or release
a replacement lease. Automated input is blocked while permission requests await local review.
Full desktop input can operate terminals and other applications; separating
Shell tools is not an OS sandbox for a caller that already has desktop control.
Input shares the existing
exclusive host authority and capture geometry validation with human remote
control. Revocation cannot undo commands or other effects already performed.

## Tools and process limits

`packages/automation/src/catalog.json` is the single source for tool names,
Schemas and permission requirements. Both TS adapters and the Rust binary consume
it. Application handlers call services; they do not automate UI clicks. Runtime
contracts belong to `packages/platform`; Tauri imports remain in `apps/desktop`.

- `devices.list`, `sessions.list`: connected devices and active streams.
- `screen.sources`, `screen.start`, `screen.stop`, `screen.configure`: native
  capture discovery, sharing without audio, and live stream configuration.
- `screen.settings.get`, `screen.settings.update`: read and update saved desktop
  video preferences, including the encoder, codec and per-encoder preset.
- `control.acquire`, `control.bindWindow`, `control.release`, `control.screenshot`, `control.pointer`,
  `control.key`, `control.text`: exclusive monitor control and bounded screenshots.
  Screenshots default to fitting inside 1024×1024, with window/rectangle crops.
  Acquire requires a live local native monitor track. Pointer operations use
  physical desktop pixels, shared with screenshots and UIA. Keys use PC set-1
  scan codes; text excludes control characters. Existing native platform support
  determines availability.
- `commands.capabilities`: read-only discovery of the target's pipe backend,
  stdin/EOF support and available signals, using `diagnostics.read` permission.
- `commands.run`, `commands.start`, `commands.status`, `commands.read`, `commands.send`: Shell
  tasks owned by the exact caller and Shell grant that created them.
- `diagnostics.snapshot`, `diagnostics.history`, `diagnostics.start`,
  `diagnostics.stop`, `diagnostics.export`: redacted statistics and reports.
- `accessibility.capabilities`, `accessibility.windows`,
  `accessibility.snapshot`, `accessibility.wait`, `accessibility.action`: desktop accessibility
  discovery, bounded element trees, and semantic control.

## Device capability discovery

Start with `devices.list` using `target:"local"`. Every entry keeps its existing
identity fields and adds discovery metadata:

| Field                  | Meaning                                                                                           |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `runtime`              | `browser`, `desktop`, or `null` for an older peer without metadata.                               |
| `os`, `appVersion`     | Published runtime metadata, or `null` when unknown.                                               |
| `supportedTools`       | Implemented tool names, independent of enabled state and caller permission; `null` means unknown. |
| `automationEnabled`    | Actual OS automation switch, independent of the MCP controller switch.                            |
| `automationConnection` | `local`, `connected`, `connecting`, `disconnected`, or `unknown` for the automation channel.      |
| `disabledReason`       | `browser_runtime`, `automation_disabled`, `capabilities_unavailable`, or `null`.                  |
| `permissionsVerified`  | Always `false`: discovery neither verifies a grant nor requests permission.                       |

The existing `connection` describes WebRTC and `automation` only indicates an
automation capability announcement. Neither proves desktop control or shell
support. A browser peer advertises diagnostics only. A desktop with automation
disabled retains its implemented tool list while reporting the disabled switch.
Calls still pass the destination's current permission and runtime checks.

These fields are optional additions to `automation/1`; old peers stay compatible.
Missing descriptors remain unknown instead of being inferred from an open
channel. `accessibility.capabilities` and `commands.capabilities` provide the
more detailed, tool-specific limits after choosing a compatible target.

## Results and recovery

Every tool publishes a structured success/error output schema. Success remains
`{ok:true,data:{...}}`; failure retains `error.code` and `error.message`.
Additional result fields are forward-compatible. Older peers may omit recovery
fields; adapters enrich their errors before returning them to the client.

MCP screenshots contain the PNG once, in an image content block. Their JSON text
and `structuredContent` contain only metadata: source, physical bounds, actual
image dimensions, geometry revision and image-to-desktop mapping. Internal peer
transport and browser WebMCP retain their existing image payload representation.

Errors provide the following recovery information:

- `outcome: "not_applied"` means a read-only call or a failure known to precede
  execution. `"unknown"` means a state-changing operation may have taken effect;
  cancellation, revocation, disconnection and deadlines do not undo OS effects.
  `"applied"` is reserved for an explicitly confirmed side effect.
- `retryable` is true only for a transient failure whose outcome is known not
  to have applied a change. Explicit cancellation is never automatically retried.
  Restore any required connection or permission before retrying.
- `nextAction` suggests an action such as `observe`, `reconnect`,
  `request_permission`, `inspect_capabilities` or `fix_arguments`.
  These are guidance, never authorization or a promise that a retry will succeed.
- `retryAfterMs`, when present, is a suggested delay for a retryable failure.

After an uncertain click, toggle, text input or Shell start, observe the target
before repeating the operation. A confirmed action followed by an observation
failure must retain its applied result instead of presenting the action as
unexecuted. Peer request deadlines report `TIMEOUT`; explicit aborts report
`CANCELLED`. Existing per-connection duplicate detection is not a durable
idempotency ledger across fresh calls or reconnects.

## Video preferences

`screen.settings.get` returns saved video preferences, discovered encoders with
their codecs and presets, and available monitor/window capture backends. It uses
`screen.read`; `screen.settings.update` uses `screen.configure`. Both require a
desktop target with automation enabled and reuse the existing local token or
remote device permissions. Only video preferences are exposed, not credentials,
network configuration, audio consent or automation permissions.

Pass a nonempty `patch` to update only the requested fields. Unknown fields,
out-of-range values and unsupported encoder/codec/preset/backend selections are
rejected before any preference is written. Encoder and codec must either both be
`auto` or form a pair returned by the getter. The preset belongs to the resulting
encoder; changing encoders restores that encoder's remembered preset unless the
patch also supplies one. `maxBitrate` is in bits per second.

```json
{
  "name": "screen.settings.update",
  "arguments": {
    "target": "local",
    "patch": {
      "encoder": "software",
      "codec": "video/h264",
      "preset": "latency"
    }
  }
}
```

Updates use the same persisted preference store as Settings. The response includes
`previous`, `settings` and changed fields grouped under `application`:

- `liveUpdateRequested`: resolution, frame rate, bitrate and degradation preference
  use the application's asynchronous live-update path. This is not confirmation
  that a running stream accepted the update; inspect diagnostics afterward.
- `nextShare`: encoder, codec, preset, capture backends, readback buffers and color
  preferences apply to the next share. No capture is restarted by this tool.

The getter reports saved preferences, not negotiated or effective running values.
Automatic encoder selection can fall back to the balanced preset, and VP8 uses
BT.601 limited range regardless of other saved color preferences. Explicit VP8
color patches must match that restriction. `screen.configure` remains available
for direct, temporary changes to one active track without saving preferences.

## Coordinates

`desktopPhysicalPixels` is the common automation coordinate space. The origin is
Windows' physical desktop origin; monitors to the left or above can have negative
coordinates. Bounds are already oriented. Never multiply these values by the OS
DPI scale or apply the monitor rotation again.

`screen.sources` includes the display layout and its `geometryRevision` when
available. `control.acquire` returns `sourceId` (the native monitor ID), `bounds`,
`virtualBounds` and `geometryRevision`. The publication/track ID is distinct from
this native source ID. `accessibility.windows` and `accessibility.snapshot` label
their node bounds with the same coordinate space.

`control.screenshot` returns the PNG plus `imageWidth`, `imageHeight`, physical
`bounds`, `geometryRevision` and `imageToDesktop`. For image coordinates measured
from its upper-left edge:

```text
desktopX = imageX * imageToDesktop.scaleX + imageToDesktop.offsetX
desktopY = imageY * imageToDesktop.scaleY + imageToDesktop.offsetY
```

Choose a monitor **or window** `sourceId` from `screen.sources`; a window source
uses native window capture. This ID is different from an accessibility `elementId`.
Screenshots default to fitting inside **1024 × 1024** pixels, preserving aspect
ratio without enlarging smaller sources. Optional `maxWidth` and `maxHeight`
each accept 1–2048 pixels and independently default to 1024. For example, a
1920 × 1080 monitor returns 1024 × 576 by default; requesting both limits as
2048 retains its original resolution. Source-picker previews remain 640 × 360.

Optional `rect: {left, top, width, height}` crops the selected monitor or window
in **absolute physical desktop pixels, before resizing**. All fields are
integers, width/height must be positive, and the rectangle must lie wholly inside
the selected source (`RECT_OUT_OF_BOUNDS` otherwise). Negative desktop origins
are supported. There is no implicit clipping, padding, or window-relative mode.
A small crop therefore retains native small-text detail instead of enlarging a
thumbnail. To inspect a 600 × 400 area on a monitor left of the primary display:

```json
{
  "name": "control.screenshot",
  "arguments": {
    "target": "local",
    "sourceId": "<monitor or window sourceId from screen.sources>",
    "rect": {
      "left": -1800,
      "top": 100,
      "width": 600,
      "height": 400
    }
  }
}
```

The returned `bounds` describe the cropped desktop rectangle; `imageToDesktop`
includes both its offset and any scaling. Pointer input always remains in
`desktopPhysicalPixels`: map image points with that transform and use the monitor
`sourceId`/`geometryRevision` from `control.acquire`, even for a window screenshot.
PNG uses balanced lossless DEFLATE compression with adaptive row filtering.
The default size keeps even incompressible RGB images below the 4 MiB limit;
prefer window or rectangle crops for small-text detail. Explicit larger sizes
share the same 4 MiB budget on local and peer transports.
`RESULT_TOO_LARGE` requires a smaller region or output dimensions; the
service does not silently lower the requested resolution or switch to a lossy format.

Pass a mapped screenshot point or a UIA node's physical center to `control.pointer`
with `coordinateSpace: "desktopPhysicalPixels"`, and the `sourceId` and
`geometryRevision` returned by `control.acquire`. The point must be inside that
monitor. For a different monitor, release and acquire its live stream first.
Physical rectangles include their left/top edge and exclude their right/bottom
edge. Fractional physical positions are rounded to the nearest pixel center.

Every pointer call requires `coordinateSpace: "desktopPhysicalPixels"`,
`sourceId` and `geometryRevision`. Stale revisions and mismatched sources are rejected;
out-of-monitor coordinates are never redirected to an adjacent display.
A changed layout invalidates the native control lease, so refresh and reacquire.

Window screenshots map WGC's frame to DWM's physical visible window bounds.
Capture checks the original frame extent and the bounds before and after capture.
A frame/bounds mismatch (`CAPTURE_BOUNDS_MISMATCH`) or changed geometry
(`GEOMETRY_CHANGED`) returns an error instead of a guessed mapping. Window
screenshots do not authorize window control; pointer actions still require the
monitor lease containing the chosen point. A screenshot or UIA observation is
not a lock on another application's UI: refresh after its window or elements move.

## Pointer actions

`control.pointer` requires `action`, `target`, `coordinateSpace`, `sourceId`,
`geometryRevision`, `x` and `y`. All points use physical desktop pixels inside
the acquired monitor. Each action accepts only its own parameters:

| Action        | Behavior and additional parameters                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `move`        | Move directly to `x/y`. With `path`, start at `x/y` and follow the waypoints over `durationMs`.                                                  |
| `down` / `up` | Press or release `button` at `x/y`; the pressed state survives between successful calls.                                                         |
| `click`       | Press then release; `clickCount` is 1 or 2 (default 1), `holdMs` is 1–2,000 (default 30), `intervalMs` between clicks is 40–1,000 (default 100). |
| `drag`        | Press at `x/y`, follow required `path`, then release at the final waypoint.                                                                      |
| `scroll`      | Scroll at `x/y`; both `scrollX` and `scrollY` are required, each −1,200…1,200. Set the unused axis to 0; 120 units is one detent.                |

`button` defaults to `left`; `right`, `middle`, `back` and `forward` are also
available. `path` contains 1–128 `{x,y}` waypoints after the initial `x/y` point.
`durationMs` applies only to paths, defaults to 500 ms and accepts 16–10,000 ms.
Segments receive equal time slices with interpolation steps no more than 16 ms
apart. Timing is best effort; a host stall over 500 ms aborts the gesture instead
of replaying old input in a burst. Entire paths are checked before pressing a
button, including intermediate points and the destination.

For example, after acquiring the monitor and reading its current layout:

```json
{
  "target": "local",
  "action": "drag",
  "coordinateSpace": "desktopPhysicalPixels",
  "sourceId": "<sourceId from control.acquire>",
  "geometryRevision": "<geometryRevision from control.acquire>",
  "x": 200,
  "y": 300,
  "path": [
    { "x": 400, "y": 300 },
    { "x": 500, "y": 450 }
  ],
  "durationMs": 800,
  "button": "left"
}
```

For incremental dragging, use `down`, one or more `move` calls, then `up`.
Repeated `down` on a held button and `up` on an unheld button are rejected.
`click` and `drag` require all buttons to be released first. Results include
`heldButtons`, `heldKeys`, `holdExpiresInMs` (null when none are held) and the applied
sample count. Keys and buttons share a 30-second safety deadline from the first
press; moving or pressing another key/button does not extend it. The lifecycle watchdog checks idle
holds every second. Permission reviews also interrupt held input. Stateless HTTP
clients do not provide a persistent connection-disconnect signal; the hold
deadline bounds an abandoned `down` call when no `up` arrives.

Pointer gestures, key/text input, UIA actions and control acquisition share one
FIFO. A gesture keeps its turn until the native worker actually stops, even if
the caller drops its waiting future. Queued calls recheck authority and the exact
native control lease before executing. Cancelling queued work does not interrupt
the active gesture. `control.release` bypasses the queue to stop control immediately.

Execution checks cancellation and authority between samples and while waiting;
waits hold no application permission mutex. After input begins, cancellation,
injection failure, lost authority or stale geometry releases that exact control
lease, including held buttons. Capture end, remote-peer disconnect, grant expiry, shutdown
and emergency release use the existing native cleanup. A late cleanup cannot
release a new owner's or reacquired lease. After an interrupted gesture or hold
timeout, acquire control again before sending more input.

## Direct desktop input (default)

Use a live native monitor track from `sessions.list`, or create one with
`screen.start`, then call `control.acquire` with its `trackId`. Call
`control.pointer`, `control.key` and `control.text` directly afterwards;
`accessibility.windows`, `accessibility.action` with `focus`, and `control.bindWindow`
are not prerequisites.

Keys and text go to the current foreground application's focused control. Pointer
actions use physical desktop coordinates with the acquired `sourceId` and
`geometryRevision`; clicking a control can select it as with a physical mouse.
Weblink itself can remain in the background. Switching between application windows
does not end an unbound desktop lease. This does not deliver keys to a particular
background window; the foreground application determines their recipient.

Keep the lease for subsequent input calls. If it already has an optional window
binding, call `control.release` and `control.acquire` to return to desktop input;
repeating `control.acquire` alone preserves the existing binding.

## Optional window confinement

Only when input must stay inside one window, after `control.acquire`, call
`accessibility.windows` and choose the desired
top-level window by its returned name/process information. Pass that window's
`elementId` as `windowId` to `control.bindWindow`:

```json
{
  "name": "control.bindWindow",
  "arguments": {
    "target": "local",
    "windowId": "<elementId from accessibility.windows>"
  }
}
```

This requires `input.control`, the current exclusive native lease, and a live
window reference owned by the same caller. Child elements, arbitrary HWNDs,
expired references and references from another caller are rejected. All held
keys/buttons must be released. Binding activates the selected visible,
non-minimized window once and confirms its foreground/focus ownership. If
activation fails, no keyboard or pointer input follows. Windows applies its
normal [foreground activation restrictions](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow).

The result is `{bound:true, windowId, focusPolicy:"stopOnBlur"}` inside the usual
success envelope. Later `control.key`, `control.text` and `control.pointer` calls
inherit this binding without extra arguments. Existing queued input admitted
before the binding change fails with `WINDOW_BINDING_CHANGED`. A lease can be
bound only once; to change/remove the target, release control and acquire again.
The native binding remains valid beyond the discovery reference's TTL, subject
to the control lease and native window identity/lifetime.

Window validity and keyboard focus are checked on the native input thread before
injection, including between Unicode submissions. Pointer coordinates remain
physical desktop pixels and must be inside both the acquired monitor and the
visible bound window; points covered by another top-level window are rejected.
A private window-lifetime marker prevents a recycled native handle from silently
becoming the input target. The marker is removed when its native guard is dropped.
Idle bound input is checked about every 50 ms. Window destruction, minimization
or focus loss interrupts input and releases held keys/buttons; returning focus
does not resume it automatically. Acquire and bind again after interruption.

An action can take effect before its final lease check fails. For example,
clicking a bound calculator's close button or sending Alt+F4 can close the window,
then return `WINDOW_FOCUS_LOST` as the remaining input sequence loses its target.
Bound input and accessibility actions retain their original window reference
through lease cleanup so this interruption is reported consistently. This is
not a close-success result and does not roll back already submitted input. Query
`accessibility.windows` or take a fresh `control.screenshot` to determine the
actual outcome before deciding whether to retry. If the intended window has
closed, the close task is complete; acquire a new lease only for further input.
Calls without an active lease still return `CONTROL_REQUIRED`; permission
revocation, cancellation and emergency stop keep their existing errors.

This is foreground input confinement, not a background message/input injection
API. Dialogs or popups that become separate foreground windows require a new
binding. UIA semantic actions continue to use their explicit element targets;
binding does not redirect them. There is no OS-atomic transaction between
foreground checks and `SendInput`; the checks are made immediately before native
submissions rather than claiming to lock the user's foreground window.

## Keyboard actions

`control.key` uses named physical key positions (such as `Enter`, `KeyC`,
`ControlLeft`, `ControlRight`, `ShiftLeft`, `AltRight`, `MetaLeft`, `ArrowDown`
and `NumpadEnter`). These names follow `KeyboardEvent.code`, not the character
produced by the active keyboard layout. The shared catalog enumerates supported
names; Pause, PrintScreen, media keys and F13–F24 are not supported. Use
`control.text` for characters. The development API no longer accepts raw
`scanCode` / `extended` arguments.

| Action  | Required arguments | Behavior                                                                      |
| ------- | ------------------ | ----------------------------------------------------------------------------- |
| `press` | `target`, `key`    | Press and release one key, optionally repeated.                               |
| `down`  | `target`, `key`    | Keep a key held across successful calls.                                      |
| `up`    | `target`, `key`    | Release a key held by the current control lease.                              |
| `chord` | `target`, `keys`   | Press 2–8 distinct keys in the supplied order, then release in reverse order. |

`press` and `chord` accept `holdMs` (1–2,000, default 30), `repeat` (1–100,
default 1), and `intervalMs` (0–1,000, default 100). The interval starts after
the preceding release; the hold starts after the final key-down submission.
The total requested hold/gap duration must not exceed 10 seconds. Execution is
best effort and capped at 15 seconds including submission time; a single native
submission or scheduling stall over 500 ms aborts the sequence.

For example, save with Ctrl+Shift+S:

```json
{
  "target": "local",
  "action": "chord",
  "keys": ["ControlLeft", "ShiftLeft", "KeyS"],
  "holdMs": 50
}
```

To select with Shift+drag, call `control.key` with `action: "down"` and
`key: "ShiftLeft"`, perform a pointer `drag`, then release Shift with `up`.
Pointer gestures preserve held keys. Key presses/chords preserve other held
keys and mouse buttons; including an already held key is rejected before input.
Repeated `down` and an unmatched `up` are also rejected. All keyboard actions
return the same held-state fields as pointer actions.

`control.text` accepts `target`, `text` (1–4,096 Unicode characters) and optional
`intervalMs` (0–1,000, default 0). With zero spacing, it sends chunks of at most
32 Unicode characters, without splitting UTF-16 surrogate pairs. Positive
spacing sends one character at a time; requested gaps must total at most
10 seconds. It rejects control characters, including newline and Tab: use
explicit `Enter` or `Tab` key actions between text calls. Text also requires all
held keys and buttons to be released. It sends committed text to the currently
focused application; it does not automate IME composition or change focus.
On Windows, supported native Unicode Edit/RichEdit controls in another process
receive bounded text replacements at the caret or current selection, preserving
undo and avoiding rapid keyboard-packet corruption in Notepad. Default batches
yield briefly between submissions so the editor can process window messages.
Other controls retain Unicode keyboard injection. This does not use the clipboard or change
the input method. Read-only/disabled editors do not opt into direct insertion.
Focus and window confinement are checked before each submission. A failed or
timed-out submission ends the input lease without retrying the text, since it
may already have been inserted.

Key events, character chunks and timed waits recheck cancellation, permission,
the exact native lease and the shared hold deadline. Only the bounded native
submission holds the authority mutex; waits and gaps do not. Cancellation after
execution starts releases the exact lease, including both keys and buttons.
Already typed text cannot be rolled back and a failed text call must not be
blindly retried. Preflight errors send no input and preserve previously held
keys/buttons. This uses the same FIFO, cleanup and abandoned-hold watchdog as
pointer actions, including protection against old cleanup affecting a new lease.

## Desktop accessibility

Windows uses UI Automation. macOS and Linux currently report `supported: false`;
other accessibility operations return `UNSUPPORTED`. Browser-local UIA calls
return `UNSUPPORTED`; WebMCP can target a connected Windows desktop through the
existing authorized peer route.

The portable Rust `Backend` trait in `crates/desktop-accessibility` owns OS
discovery, inspection and actions. `packages/platform/src/accessibility.ts`
defines the corresponding TS contract. Future macOS AX or Linux AT-SPI adapters
implement this backend without changing the tool names, consent flow or transport.
Roles and actions are platform-neutral; a node advertises only its available
actions. Native pointers, HWNDs and COM interfaces never leave the backend.

### Reading state and content

Use `accessibility.windows` to obtain caller-bound `elementId` references, then
`accessibility.snapshot` to read a selected subtree. The result is a flat `nodes`
array with `parentId`, `depth`, role, name, automation ID, process ID, physical
desktop bounds and supported actions. Where the provider implements them, nodes
also include `toggleState`, `selected`, `expandCollapseState` and `readOnly`.
Missing optional states mean unavailable, not false.

Value/Text pattern contents are opt-in. Set `includeValues:true` on a snapshot
or follow-up observation to obtain `value` and/or `text`. `maxTextLength`
defaults to 1,024 Unicode characters and accepts 1–4,096; `valueTruncated` and
`textTruncated` report omitted content. Names are bounded to 512 characters and
carry `nameTruncated:true` when shortened. Default snapshots do not query
Value/Text content. Applicable semantic states are available independently.

Reading requires the separate `accessibility.read` scope within the reading
group. Names and values can contain private application text; these results are
excluded from diagnostic reports and audit payloads. Password names and
identifiers are blank, contents are never queried, children are not traversed,
and protected elements cannot be acted on. Weblink's own window and its hosted
WebView controls are excluded to protect the consent UI.

```json
{
  "name": "accessibility.snapshot",
  "arguments": {
    "target": "<device ID>",
    "elementId": "<window reference>",
    "includeValues": true,
    "maxTextLength": 1024,
    "maxDepth": 4,
    "maxNodes": 128
  }
}
```

### Actions and follow-up observations

`accessibility.action` supports `focus`, `invoke`, `setValue`, `toggle`, `select`,
`expand`, `collapse`, and `scrollIntoView`. `setValue` requires `value` (an empty
string clears the field); other actions reject a value. Unsupported patterns
return `UNSUPPORTED_ACTION`; there is no silent keyboard or coordinate fallback.
Actions require `input.control` permission **and an active `control.acquire`
lease on a live native monitor stream**, plus the original read grant for their
element references. They share exclusivity and emergency release with existing
remote input. The monitor is the control lease's anchor; semantic actions can
target other windows across the desktop. Pending local permission reviews block
all automated input, including UIA actions.

Optional `observeAfter` requests a fresh subtree after an applied action.
Its `elementId` defaults to the acted-on element and is resolved before old
references are invalidated; it never selects a replacement by name. Observation
defaults to two levels/64 nodes, with the same eight-level/256-node hard limits
and opt-in content options as snapshots.

```json
{
  "name": "accessibility.action",
  "arguments": {
    "target": "<device ID>",
    "elementId": "<field reference>",
    "action": "setValue",
    "value": "ready",
    "observeAfter": {
      "elementId": "<window reference>",
      "includeValues": true,
      "maxDepth": 2,
      "maxNodes": 64
    }
  }
}
```

A successful observation returns `applied:true`, `refreshRequired:false` and
`observation`, whose fresh references may be used for the next call. If the
action completes but the optional observation fails, the result retains
`applied:true`, sets `refreshRequired:true`, and includes
`observationError:{code,message}`. A failed observation is not a reason to replay
the action. Without `observeAfter`, the original
`applied:true,refreshRequired:true` result is unchanged.

The final authority check still discards UI data after revocation. When that
boundary already knows the action was applied, its failure preserves
`error.outcome:"applied"` without returning the revoked observation. A response
lost before acknowledgement may still have an unknown outcome.

### Waiting for a condition

`accessibility.wait` reads the same referenced element until every supplied
condition holds. It requires `accessibility.read`, not an input lease. Conditions
may include `enabled`, `focused`, `offscreen`, `selected`, `toggleState`,
`expandCollapseState`, exact `name`, exact `value`, and `textContains`.
The condition object must be nonempty. Exact comparisons never match a truncated
name or value; text search checks only the first 4,096 returned characters.
Value/Text patterns are queried only when the condition needs them.

```json
{
  "name": "accessibility.wait",
  "arguments": {
    "target": "<device ID>",
    "elementId": "<checkbox reference>",
    "condition": { "enabled": true, "toggleState": "on" },
    "timeoutMs": 10000,
    "pollIntervalMs": 100
  }
}
```

The default timeout is 5,000 ms, bounded to 1–30,000 ms. Polling defaults to
100 ms and accepts 50–1,000 ms. Matching returns
`{matched:true,timedOut:false,elapsedMs,node}` with a fresh caller-bound reference.
Expiry of the condition deadline returns
`{matched:false,timedOut:true,elapsedMs,node:null}`. A stale element, revoked
grant or provider failure remains a tool error rather than a condition timeout.
Polling does not extend the original reference's lifetime or allocate throwaway
references on each failed check.

### References and execution bounds

References expire after 60 seconds, when the original read grant ends, or after
an action reaches dispatch. An action invalidates every old reference belonging
to that caller, including after a provider error/timeout; refresh the UI or use
the new references returned by a successful observation. References cannot be
used by another caller or reconnected session. A changed or reparented UI element
is never reselected by a potentially ambiguous label.

Snapshots default to 128 nodes/four levels, with hard limits of 256 nodes/eight
levels. `truncated` indicates omitted children; expand a returned child reference
to inspect deeper. Window lists are bounded to 128 entries. The native cache
holds at most 2,048 references, so other discovery operations can evict references
earlier.

UIA runs on a single dedicated COM MTA thread, with four queued requests, an
eight-second deadline per worker request and 500 ms provider connection/
transaction timeouts. Wait polling and sleeps occur outside that worker; each
inspection is also bounded by the condition's remaining deadline. Action and
follow-up observation are separate worker requests, so a blocked observation
does not erase the action acknowledgement.

Authority is rechecked between traversal/polling steps, just before a native
action and before returning UI data. Native provider calls hold no application
permission lock. Cancellation/revocation prevents queued work; a side effect
already dispatched to another process cannot be undone or forcibly interrupted.
An unresponsive provider may keep the single worker busy until its call returns;
the UI and permission controls remain responsive. No elevation or UIAccess bypass
is attempted, and inaccessible or elevated windows may not be available.

Windows implementation follows Microsoft's guidance on
[UIA client threading](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)
and [provider transaction timeouts](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-get_transactiontimeout).

## Shell execution

Terminal permission is kept separate from desktop reading and control. An
interactive PTY transport is not implemented; future terminal tools can share
this permission group and the same caller/target ownership and revocation rules.

`commands.run` waits for completion and returns `jobId`, `status`, `exitCode`,
`chunks`, `startCursor` and `nextCursor`. Its output is the latest 16 KiB, so final
results and errors remain visible after verbose logs. Earlier retained output
is available through `commands.read` with an explicit cursor.
`waitMs` defaults to 10 seconds and is bounded to
1–60,000 ms. If the wait ends first, `background: true` means the job continues;
use `commands.status`, `commands.read` and `commands.send` with its `jobId`.
`commands.start` always returns only `jobId` immediately. Both use the same job
manager, concurrency limit, caller ownership and terminal permission.

### Reading a background job

Start the job (this example uses Windows PowerShell):

```json
{
  "name": "commands.start",
  "arguments": {
    "target": "local",
    "script": "Write-Output 'started'; Start-Sleep -Seconds 2; Write-Output 'finished'",
    "timeoutMs": 60000
  }
}
```

The success payload is `{ok:true,data:{jobId:"..."}}`. Standard MCP exposes this
envelope as `structuredContent` and as JSON text content. Read the latest output
without first querying the job's size:

```json
{
  "name": "commands.read",
  "arguments": {
    "target": "local",
    "jobId": "<returned jobId>"
  }
}
```

No selector means the latest 16 KiB. Optionally supply **one** of:

- `tailBytes: 8192`: latest 8 KiB; accepts 1–16,384 bytes.
- `tailLines: 50`: latest 50 lines; accepts 1–1,000 lines, still capped at 16 KiB.
  `tailLimited:true` means the line selection exceeded this byte cap and its
  beginning was omitted. Lines use LF in the combined arrival order of stdout
  and stderr; CRLF is preserved, and a trailing LF does not add an empty line.
- `cursor: <nextCursor>`: continue forward from an absolute byte offset, up to
  16 KiB per page. `cursor:0` starts from the earliest retained output.

These modes are mutually exclusive. Repeating a tail request gives another
snapshot, potentially overlapping the previous one. To follow new output, use
the first response's `nextCursor` for all subsequent reads.

The success envelope's `data` contains `chunks`, `startCursor`, `nextCursor`,
`hasMore`, `bytes`, `retainedBytes`, `earliestCursor`, `truncated`, `cursorExpired`,
`tailLimited`, `outputIncomplete`, `status` and `exitCode`. Each chunk is tagged `stdout` or `stderr`
and includes display `data` plus exact `dataBase64` bytes. Cursors are cumulative
byte offsets across both streams and never reset when old output is evicted.
Pass `nextCursor` unchanged, including when no new output was available. Do not
count characters or keep a cursor per stream.

The buffer always retains the **newest** output, up to 4 MiB and 8,192 contiguous
stream segments. It evicts the oldest bytes/segments to make room. `bytes` counts
all bytes observed, `retainedBytes` is the current buffer size, and
`earliestCursor` is the first available offset. `truncated:true` means some old
output was evicted; intentionally choosing a tail alone does not set it.

If an explicit cursor has fallen behind `earliestCursor`, reading resumes there
with `cursorExpired:true`; `startCursor` shows the actual beginning of the page.
The lost byte count is `startCursor - requestedCursor`. A cursor beyond `bytes`
is invalid. An up-to-date reader can have `cursorExpired:false` even when
`truncated:true`, because it already consumed the evicted prefix.

The polling rule is:

```text
page = commands.read(target, jobId).data  // latest output first
loop:
    if page.cursorExpired: report gap and reset streaming decoders
    consume page.chunks
    cursor = page.nextCursor
    if not page.hasMore:
        if page.status != "running": stop
        wait approximately 500 ms
    page = commands.read(target, jobId, cursor).data
```

`hasMore:false` means caught up now; it is not an end-of-output notification.
When reading from an explicit cursor, even a completed job can still have unread
pages. Finish only when both
`status != "running"` and `hasMore == false`. `commands.status` is optional for
status-only polling and returns no output. After sending a termination signal,
continue reading to drain retained output and observe the terminal status.
Reads are polling, not a pushed stream, and process-side buffering
can delay when new bytes become available. Terminal status is published only after
both output readers have stopped. `outputIncomplete:true` reports a pipe read
failure or the two-second drain deadline; it is distinct from normal cache
eviction and means the collected output may not include all process output.

### Sending input and signals

Query `commands.capabilities({target})` before choosing a signal. Discovery runs
on the addressed device, including remote targets; it never infers remote
support from the controller's operating system. It requires `diagnostics.read`,
starts no process and does not grant `shell.execute`. The normal automation
enablement and permission checks still apply. The result describes the backend,
not whether an interpreter is installed or whether a particular job will exit
after receiving a signal.

A Windows desktop returns:

```json
{
  "supported": true,
  "transport": "pipe",
  "stdin": true,
  "eof": true,
  "pty": false,
  "supportedSignals": ["SIGTERM", "SIGKILL"],
  "signalSemantics": {
    "SIGTERM": "terminate-process-tree",
    "SIGKILL": "terminate-process-tree"
  }
}
```

Unix desktops additionally list `SIGINT` as `interrupt-process-group` and describe
`SIGTERM` as `terminate-process-group`; `SIGKILL` remains
`terminate-process-tree`. Browser-local WebMCP discovery returns `supported:false`,
`transport:"none"`, `stdin:false`, `eof:false`, `pty:false`, `supportedSignals:[]`
and `signalSemantics:{}`. Browsers still do not accept incoming peer automation.
An older target without this tool returns `UNSUPPORTED`; the controller does not
replace that response with its own capabilities. All desktop jobs retain pipe
transport without terminal emulation.

`commands.send` replaces `commands.cancel`. Use `signal: "SIGKILL"` for the old
cancel behavior. Every send requires the original caller, target and Shell grant.
A completed or cancelling job rejects sends with `JOB_NOT_RUNNING`.
This also applies while a stopped process's final output is still being collected.

Stdin remains open until explicitly closed or the job ends. Send literal UTF-8
text with `input`; newlines are not added automatically. Each call accepts up to
16,384 Unicode characters / 65,536 UTF-8 bytes. Up to eight input messages can be
queued per job. `BUSY` means the new message was not queued. The response
`{queued:true,bytes:...,eof:...}` confirms queue acceptance, not that the process
has consumed the input. Sends are serialized in accepted order; a blocked stdin
pipe does not block other tools, signals, permission revocation or emergency stop.

```json
{
  "name": "commands.send",
  "arguments": {
    "target": "local",
    "jobId": "<returned jobId>",
    "input": "hello\n",
    "eof": true
  }
}
```

`eof:true` closes stdin after earlier queued input and the input in this call.
It can also be sent alone. Once EOF is accepted, later input is rejected with
`STDIN_CLOSED`. Run results, reads and status include `stdinStatus`: `open`,
`closing` (EOF queued), `closed`, or `failed` (a pipe write failed). Cancellation
or exit discards input that has not yet been written. PowerShell still runs with
`-NonInteractive`; use standard input APIs or native programs, not `Read-Host` or
console UI prompts. This does not add a PTY or terminal emulation.
JSON-escaped control characters (including `\u0003` and `\u0004`) are written
literally; they do not implicitly send signals or close stdin. Each message's
buffered writes are flushed so deferred pipe failures are reported even when
there is no subsequent send. Successful EOF finishes those writes before closing
stdin; a write failure preserves `stdinStatus:"failed"`.

Signals are mutually exclusive with `input` and `eof`:

- `SIGKILL`: cancel the task and terminate its process tree on all platforms;
  terminal status is `cancelled`.
- `SIGTERM`: send TERM to the process group on Unix; on Windows, terminate the
  process tree (Windows has no POSIX TERM delivery). A Unix handler may keep the
  job running; use `SIGKILL` if forced termination is required.
- `SIGINT`: send INT to the process group on Unix. Windows returns
  `UNSUPPORTED_SIGNAL`, since these jobs have no console or PTY for Ctrl+C.

Signal acceptance returns `{queued:true,signal:...}`; poll for completion rather
than assuming immediate exit. Signal delivery bypasses the stdin queue. Grant
revocation, expiry, emergency stop and shutdown always force process-tree cleanup.

`data` is a lossy UTF-8 display view; byte-based tail selection, eviction and page
boundaries can split a character or a line.
For exact text, decode `dataBase64` and use a separate streaming decoder for each
stream (or concatenate bytes per stream before decoding), using the program's
actual encoding. Reset both decoders when `cursorExpired` signals a gap; do not
join bytes across missing output. Flush decoders only when the job ended and all
requested pages were read.

Use the same target, caller/token identity and original terminal grant. A new
grant does not grant access to an older job. Jobs/output are in memory, do not
survive application restart and completed records may be removed when the
32-record limit is reached. Grant expiry/revocation or disconnect cancellation
can stop a running job; `start` is a background handoff, not an independent
durable service.

`waitMs` limits the tool's wait; `timeoutMs` independently limits process lifetime.
Run results and reads contain at most 16 KiB of retained output per page. `hasMore`
means more retained bytes remain; a running job may produce more bytes later even
when it is false. Continue reading from `nextCursor`; use an explicit earlier
cursor if the default tail omitted older output you want to inspect. Nonzero exits
are completed jobs with their exit code; process timeouts report `timed_out`.
Cancelling a run request while it waits cancels its job. A successful background
handoff releases this call-level cancellation, while grant revocation/expiry and
shutdown continue to cancel the owned process tree for both run and start.
Waiting does not hold the authority mutex, so permission changes remain available.

Windows prefers noninteractive `pwsh.exe`, falling back to `powershell.exe` only
when the preferred executable is missing. A script failure never triggers a
retry in another interpreter. Each Windows job sets console input/output and
PowerShell native-pipeline encoding to UTF-8 without a BOM, and defaults cmdlet
`Encoding` parameters to `utf8` (explicit script parameters override this).
Windows PowerShell may still write a BOM to UTF-8 files. Programs that explicitly
emit another encoding still require decoding their raw output accordingly.
Other platforms use `/bin/sh`. Commands run at the app account's privileges.
It is **not a sandbox**; a working directory is not an access boundary.
No privilege elevation is performed.
Only basic OS environment variables are inherited, not app credentials.
Tasks default to 60 seconds, have a ten-minute maximum, and are limited to ten
concurrent tasks per device. Output retention is bounded to 4 MiB per task and
32 task records. Once output or segment limits are reached, the oldest output
is evicted while new output continues to be retained. Reads use absolute byte
cursors and include base64 bytes for exact
reconstruction across Unicode boundaries. Completion, cancellation and timeout
clean up the owned process group/job. Shell processes can have lasting effects;
this mechanism is intended for attended diagnostics and automation, not hostile
code isolation.

## Diagnostics

An application-owned sampler runs during active video sessions, independently
of the settings view. It samples approximately once a second and keeps five
minutes in memory, bounded to 8 MiB. It distinguishes local preview, sending and
receiving, and includes player state/compositor statistics where a player is
mounted. Background scheduling gaps and missing metrics remain explicit; no
end-to-end latency is inferred from unrelated stage measurements.

Detailed collection is explicitly enabled for at most five minutes and adds
cumulative counters and native pipeline timings. Reports preserve error codes,
codec implementation, runtime version and correlation IDs, while excluding raw
RTC reports, SDP, IP addresses, paths, credentials and screen contents. History
and tool exports are paginated in groups of up to 30 samples; the settings export
collects the entire retained window. Closing the app discards this history.
Audit records are bounded to 1,000 calls and contain caller, tool, target, time
and outcome; they omit scripts, command output, screenshots and typed text.

Protocol references: [WebMCP](https://webmachinelearning.github.io/webmcp/),
[Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk),
[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http).
