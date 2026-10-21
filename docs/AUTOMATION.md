# Automation: WebMCP and MCP

Weblink exposes a shared tool catalog through browser WebMCP and a native MCP
server. Enable **Settings → Automation** separately on every participating
device. Automation starts disabled on first use; subsequent page/app restarts restore
the last successfully selected switch state. Native startup waits for its authority
channel before restarting the listener. A failed bind reports the error without
clearing the saved preference.

## Connecting

A supporting browser uses the [WebMCP `document.modelContext` API](https://webmachinelearning.github.io/webmcp/). The switch
stays off and disabled when WebMCP is unavailable, without erasing the saved
preference. Automation becomes active only after tool registration succeeds;
registration failure, disabling automation or closing the page aborts the
registrations. The browser is a controller, with no local
Token management or permission approval screen. Incoming peer automation calls
to a browser are rejected; OS input and Shell execution require a desktop target.

On desktop, create one MCP credential per client in Automation settings. Copy
the displayed Streamable HTTP URL and Authorization header into the client's
MCP configuration. The **MCP server** settings configure the listening host and
port. Text fields save automatically on blur, including while automation is running.
Listener changes take effect the next time automation is enabled, preserving
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
same deferred application path. Host and port persist across restarts. Existing
registries without a host retain their saved nonzero port and default to
loopback. Legacy unallocated (`null`) ports use the fixed default.
A port conflict is an explicit startup error; it never silently changes a saved
port. Changing the endpoint preserves tokens, but clients must update their URL.

The desktop-only **Local MCP tokens** list supports named tokens, an expiration
time (including custom dates), no expiration, editing and revocation. Creation
and editing use child dialogs; existing token settings save automatically, while
creation remains an explicit action that generates a new credential. Restoring
the default validity sets a 30-day deadline without changing the token name or
secret. The compact list shows token summaries and actions. The full
random token is displayed only at creation. Only a SHA-256 hash, a short prefix,
name, creation time and expiration are stored in `mcp-tokens.json` in the local
app-data directory. Changes are written atomically before becoming active. The
list, creation, editing and revocation remain available while automation is
disabled. Issuing a token authorizes local tool calls and forwarding without an
additional local approval, but never starts the listener;
its connection configuration uses the saved endpoint when the server is off. Tokens survive disabling/restarting, while
runtime grants and pending calls do not. Expired tokens remain visible and can
be renewed or revoked. Every HTTP request and final native effect checks token
validity. Expiry/revocation cancels the token's grants and native tasks. Renewing
an already expired token authorizes new calls; it cannot revive old grants
or pending calls, including between background cleanup ticks.

These tokens authenticate local MCP clients only. They do not pair remote
devices, appear in remote-device permission lists, or authorize a remote device.
A valid token needs no extra local approval to connect to another client or call
a tool. The destination still enforces its own device permissions. Requests require
the accepted socket's concrete IP and port in Host, including on wildcard
listeners; arbitrary DNS names and forwarded headers never authorize a request.
A present Origin must match that HTTP origin. Browser cross-origin HTTP
requests are not enabled.

The server uses the official Rust `rmcp` SDK for protocol negotiation and
transport handling, including legacy negotiation supported by that SDK. Tool
results are structured objects with a JSON text representation; native screenshots
also produce MCP image content. No MCP credentials are sent to peers. HTTP authorization is tied to the client
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
a loop. The native
MCP authority's local heartbeat and cancellation checks are independent of peer
discovery.

## Consent and identity

Identity and authorization remain device-local. Each destination device manages
its own trust and permissions; access is not inherited from a shared user account
or another device. Local MCP client tokens and remote-device identities remain
separate credentials. SSO, identity federation and organization-wide policy are
outside the current scope. Device pairing and proof of key possession do not
require those enterprise features.

The desktop MCP entrypoint authenticates its token and checks its lifetime on
every call. Issuing the token is the local authorization, including for
`target:"local"`. Forwarding to other clients needs no further approval on the
entrypoint. WebMCP also forwards without a browser approval. The destination
desktop enforces its own peer permissions independently; an MCP source label or
the controller's token never bypasses its Ask, Always allow or Deny policies.
Permissions are presented as three independent groups:

- **Reading and diagnostics**: device/stream state, screenshots and accessibility tree content.
- **Sharing and control**: screen sharing, stream configuration, keyboard/mouse and semantic accessibility actions.
- **Terminal and commands**: Shell execution, output and task management.

`packages/automation/src/permission-groups.json` defines these groups for both
TS and Rust. Tool names and exact internal scopes remain compatible. Existing
mixed per-scope policies are retained and shown as individual legacy settings;
selecting a group decision explicitly updates its member scopes together.
Remote automation permissions live in each device's permission dialog (both the
client details and Settings → Clients and rooms). Each group supports **Ask**,
**Always allow**, and **Deny**, with Ask as the default. These policies persist in
that device's local permission record and are applied only to a currently paired,
verified peer channel. A signaling ID or reported caller name never supplies
this authority. Losing trust resets all scopes to Deny; ordinary disconnection
and automatic key repair retain the saved policy. The content reception and
screen sharing switches remain prerequisite gates.

Ask requests and current grants appear in the corresponding device dialog.
Local MCP tokens remain under Automation, without a second request/grant list,
and are independent of device policies. Toast review actions open the corresponding
device settings for a verified peer. Resolved requests dismiss their notifications;
a stale notification cannot navigate using an unverified claimed device ID.
Temporary peer approvals last 5, 15, or 60 minutes, with 15 minutes selected initially. They
bind a caller identity, target, permission group and current connection lifetime.
Consent resolves concurrent requests in that same group only. Explicit legacy
Deny decisions remain excluded from the grant. Revocation ends the whole timed
grant. Native execution still checks the exact tool scope. Existing
remote-control allowlists do not grant automation permissions. In the existing
remote-device permissions screen, **Always allow** is a persistent remote-control
policy with no expiry. It is separate from MCP tokens and automation scope grants.
Native control snapshots identify whether the active grant came from remote
control or automation. Device remote-control policy applies only to remote-control
grants; automation grants retain their own scope checks and the shared local stop.
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
Closing the UI revokes authority; crashes
or a frozen frontend expire the native heartbeat lease after 20 seconds.

Use **Stop all automation** to revoke grants, cancel queued work and command
process trees, and release automated input. The native emergency shortcut also
invalidates the affected automated input grant. Stop-all, emergency input release,
and explicit revocation of a policy grant also pause token calls and automatic Always-allow grants
until automation is disabled and enabled again. This pause does not erase saved
policies; individual timed peer approvals remain available. Automated input is blocked while permission requests await local review.
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
- `control.acquire`, `control.bindWindow`, `control.release`, `control.screenshot`, `control.pointer`,
  `control.key`, `control.text`: exclusive monitor control and bounded screenshots.
  Screenshots currently use the existing bounded native snapshot (up to 640×360).
  Acquire requires a live local native monitor track. Pointer operations use
  physical desktop pixels, shared with screenshots and UIA. Keys use PC set-1
  scan codes; text excludes control characters. Existing native platform support
  determines availability.
- `commands.run`, `commands.start`, `commands.status`, `commands.read`, `commands.cancel`: Shell
  tasks owned by the exact caller and Shell grant that created them.
- `diagnostics.snapshot`, `diagnostics.history`, `diagnostics.start`,
  `diagnostics.stop`, `diagnostics.export`: redacted statistics and reports.
- `accessibility.capabilities`, `accessibility.windows`,
  `accessibility.snapshot`, `accessibility.action`: desktop accessibility
  discovery, bounded element trees, and semantic control.

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

## Binding input to a window

After `control.acquire`, call `accessibility.windows` and choose the desired
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
other accessibility operations return `UNSUPPORTED`. Browser-local capability
queries also report unsupported, while the same WebMCP tools can target a
connected Windows desktop through the existing authorized peer route.

The portable Rust `Backend` trait in `crates/desktop-accessibility` owns OS
discovery, inspection and actions. `packages/platform/src/accessibility.ts`
defines the corresponding TS contract. Future macOS AX or Linux AT-SPI adapters
implement this backend without changing the tool names, consent flow or transport.
Roles and actions are platform-neutral; a node advertises only its available
actions. Native pointers, HWNDs and COM interfaces never leave the backend.

Use `accessibility.windows` to obtain caller-bound `elementId` references, then
`accessibility.snapshot` to read a selected subtree. The result is a flat `nodes`
array with `parentId`, `depth`, role, name, automation ID, process ID, state,
physical desktop bounds and supported actions. Reading requires the separate
`accessibility.read` scope within the reading group. Names can contain private application text; these
results are excluded from diagnostic reports and audit payloads. Password names
and identifiers are blank, their children are not traversed, and they cannot be
acted on. No Value/Text pattern contents are exported. Weblink's own window and
its hosted WebView controls are excluded to protect the consent UI.

`accessibility.action` supports `focus`, `invoke`, `setValue`, `toggle`, `select`,
`expand`, `collapse`, and `scrollIntoView`. `setValue` requires `value` (an empty
string clears the field); other actions reject a value. Unsupported patterns
return `UNSUPPORTED_ACTION`; there is no silent keyboard or coordinate fallback.
Actions require `input.control` permission **and an active `control.acquire`
lease on a live native monitor stream**, so they share exclusivity and emergency
release with existing remote input. The monitor is the control lease's anchor;
semantic actions can target other windows across the desktop. This is full
desktop control, not application/monitor sandboxing. Pending local permission
reviews block all automated input, including UIA actions.

References expire after 60 seconds, when the original read grant ends, or after
an action reaches dispatch. Refresh windows and the subtree after an action,
including a provider error/timeout; old references return `STALE_ELEMENT`.
References cannot be used by another caller or reconnected session. A changed or
reparented UI element is never reselected by a potentially ambiguous label.
Snapshots default to 128 nodes/four levels, with hard limits of 256 nodes/eight
levels. `truncated` indicates omitted children; expand a returned child reference
to inspect deeper. Window lists are bounded to 128 entries. The native cache
holds at most 2,048 references, so eviction can invalidate references earlier.

UIA runs on a single dedicated COM MTA thread, with four queued requests, an
eight-second request deadline and 500 ms provider connection/transaction
timeouts. Authority is rechecked between traversal steps, just before a native
action and before returning data. Native provider calls hold no application
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
use `commands.status`, `commands.read` and `commands.cancel` with its `jobId`.
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
status-only polling and returns no output. `commands.cancel` takes the same
`target`/`jobId`; continue reading afterward to drain retained output and observe
`cancelled`. Reads are polling, not a pushed stream, and process-side buffering
can delay when new bytes become available. Terminal status is published only after
both output readers have stopped. `outputIncomplete:true` reports a pipe read
failure or the two-second drain deadline; it is distinct from normal cache
eviction and means the collected output may not include all process output.

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

Shell defaults to noninteractive PowerShell on Windows and `/bin/sh` on other
platforms, at the app account's privileges. It is **not a sandbox**; a working
directory is not an access boundary. No privilege elevation is performed.
Only basic OS environment variables are inherited, not app credentials.
Tasks default to 60 seconds, have a ten-minute maximum, and are limited to two
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
