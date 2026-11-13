# Remote desktop

The controlled computer must run the Windows desktop app. The controller can be a phone browser, a computer browser, or another desktop client.

## Establish control {#connect}

1. [Install and open the desktop app](desktop.md) on the controlled computer.
2. Join both devices using the same signaling service, room ID, and password, then wait for [device pairing](device-trust.md).
3. Request control from member actions or the shared monitor's actions.
4. The host approves the notification or authorizes it through a saved allow policy.
5. Open the remote view on the controller and use mouse, touch, or keyboard input.

Approving a request can start monitor sharing. **Window sharing is view-only**; incoming remote input requires a controllable shared monitor.

## Permissions and ending control {#permissions}

Open that device's permissions from member details or **Settings → Clients and rooms**, then choose Ask, Always allow, or Deny. Joining a room, knowing a display name, or holding an invitation does not automatically grant control.

The controller can end control from the view's actions. The host can revoke it through the sharing status or stop sharing that monitor. Leaving the room also ends the current control connection.

| Action                          | Default shortcut     | Effect                                                                                                |
| ------------------------------- | -------------------- | ----------------------------------------------------------------------------------------------------- |
| Release input on the controller | `Ctrl+Alt+Shift+Q`   | Release captured pointer input and turn off keyboard forwarding while keeping the approved connection |
| Emergency stop on the host      | `Ctrl+Alt+Shift+F10` | Revoke current remote input and stop related automation input and commands                            |

Customize shortcuts in remote-control settings; use the combinations currently shown there. After releasing input, enable keyboard forwarding again to send keyboard actions.

## Mouse, keyboard, and phone touch {#input}

Adjust input preferences in **Settings → Remote control**:

- Choose local-pointer or capture mode. After capture, use the release shortcut to return to local interaction.
- Keyboard forwarding and pointer capture are independent. Losing focus releases current input; restore it through the controls when you return.
- On a phone, trackpad mode supports one-finger movement and tap-to-click, with optional two-finger right-click, scrolling, and zoom.
- Touch speed, scroll direction, long-press actions, and sample rate affect the controller's experience without changing host authorization.

Operating-system shortcuts and protected screens are not guaranteed to work remotely. Higher-privilege Windows applications may also reject input from a normally privileged app.

## Remote clipboard and file drop {#clipboard-and-files}

To copy content between devices, enable remote clipboard synchronization in **Settings → Transfer**. Supported text, rich text, image, and file types depend on both clients. Configure clipboard files to go to the local clipboard or file library, or turn file reception off.

The same settings area can enable remote file drop. Drop local files onto the remote view to copy them into compatible Windows applications; folders are packaged as ZIP archives. Dragging files out of the remote view into the controller's operating system is not supported.

Both features are off by default and require an active remote-control grant. File operations have a default limit of 64 MiB, adjustable from 1–512 MiB in transfer settings.

## Adjust the viewing experience {#viewing}

Use fullscreen or picture-in-picture; desktop also supports a native always-on-top window. Adjust resolution, frame rate, and bitrate for the network, reducing quality when needed.

Inspect stream statistics for connection state and the current path, or run a [connection speed test](connection.md#speed-test). It measures throughput between these devices, not general Internet bandwidth.

## Choose your next step {#unavailable}

- **Choose which devices need approval to control this computer:** adjust their [device permissions](device-trust.md#permissions).
- **Tune sharing quality or record a video source:** continue with [audio, video, and recording](media.md).
- **Control connects but the picture is black or stuttering:** follow the [video troubleshooting steps](faq.md#video).
