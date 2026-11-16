---
description: Set up a Windows host, request control from a browser or phone, and end or revoke access.
---

# Remote desktop

Use your phone or another computer to operate a Windows computer. The steps below separate what to do on the **host** (the computer being controlled) and the **controller** (the device you use to operate it).

## Before you start {#before-you-start}

| Device     | What you need                                                                                                               |
| ---------- | --------------------------------------------------------------------------------------------------------------------------- |
| Host       | The [Windows desktop app](desktop.md), running and joined to the room                                                       |
| Controller | Weblink in a phone browser, computer browser, or desktop app                                                                |
| Both       | The same WebSocket URL, room ID, and password; a working connection and completed [device pairing](device-trust.md#pairing) |

Send a chat message first to confirm connectivity. For your first session, keep someone at the host to approve the request. A browser can act as a controller, but cannot accept remote mouse and keyboard input for its own computer.

## Establish control {#connect}

### On the host: share the monitor you want to use {#share-monitor}

1. In the meeting controls at the bottom, choose **Share screen**.
2. Select a **monitor** and confirm sharing. Include system audio if you want the controller to hear it and the picker offers it.
3. Ask the controller to confirm that the shared desktop is visible.

**Window sharing is view-only.** Choose a monitor for remote input. Sharing a monitor makes its picture available to room members; it does not by itself grant them control.

### On the controller: request access {#request-control}

1. Select the host's shared monitor in the meeting area to open it as the main view.
2. Open the picture actions using the floating button and choose **Request control**. In a smaller tile, use that tile's action button.
3. Wait for approval. While the request is pending, **Cancel request** withdraws it.

You can also request control from the host's participant tile before a monitor is shared. That request asks the host to share **Screen 1 and its audio with all room members**. To choose a different monitor first, use the host-side steps above.

### On the host: approve, then check the result together {#approve-and-check}

1. Read **Allow remote control?** and check the requesting device.
2. Choose **Allow for this session** for a one-time session, or **Deny**. **Approve and add to allowlist** under the additional approval choices saves a policy for that device; an existing allow policy can authorize later requests without another prompt.
3. On the controller, confirm **Controlling** appears; on the host, confirm **Being controlled** appears.
4. Move the pointer from the controller and open an ordinary application. Before typing from a computer, turn on **Enable keyboard control**. On a phone, use **Show keyboard** in the picture actions.

**A successful session has both a visible desktop and working input.** The shared monitor maps pointer coordinates; the permission allows mouse and keyboard control of the host, and is not confined to one application or monitor. Clicking a system notification merely opens the request; choose an approval action to grant access.

## Mouse, keyboard, and phone touch {#input}

| What you want to do                      | Action                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Type from a computer keyboard            | Turn on **Enable keyboard control** in the control status. Keyboard forwarding is separate from pointer capture.                       |
| Type from a phone                        | Open **Show keyboard** in the picture actions; select a text field on the remote desktop and use the phone's keyboard.                 |
| Move and click from a phone              | Use trackpad mode: move one finger, then tap to click. Two-finger right-click, scrolling, and zoom depend on your touch settings.      |
| Return to local mouse and keyboard input | Press the controller's release shortcut, **Ctrl+Alt+Shift+Q** by default. The approved connection stays active.                        |
| Tune pointer or touch behavior           | Open **Settings → Remote control** for local-pointer/capture mode, touch speed, scroll direction, long-press actions, and sample rate. |

Losing focus releases current input. When you return, restore capture or keyboard forwarding through the controls as needed. After using the release shortcut, turn keyboard control back on before sending keys again.

Operating-system shortcuts and protected screens are not guaranteed to work remotely. Higher-privilege Windows applications may also reject input from a normally privileged app.

## Remote clipboard and file drop {#clipboard-and-files}

Both features are **off by default** and require active remote-control authorization.

- **Copy between devices:** enable remote clipboard synchronization in **Settings → Transfers**. Supported text, rich text, image, and file types depend on both clients. Choose whether clipboard files go to the local clipboard or file library, or disable file reception.
- **Copy a local file into the host:** enable remote file drop in the same settings area, then drop the file onto a compatible Windows application in the remote view. Folders are packaged as ZIP archives. Dragging files out of the remote view into the controller's operating system is not supported.

File operations have a default limit of 64 MiB, adjustable from 1–512 MiB. For a normal file transfer without a control session, use [chat attachments or shared files](files.md).

## Adjust the viewing experience {#viewing}

Use the picture actions for fullscreen or picture-in-picture. Desktop also supports a native always-on-top window.

Start with automatic encoding. For text, prioritize readable resolution; for motion, balance frame rate and bitrate. Change one setting at a time, and lower frame rate or resolution when the link cannot sustain them. See [sharing quality](media.md#quality) for the settings and which changes need a new sharing session.

Use stream statistics to check the connection and current media path, or run a [connection speed test](connection.md#speed-test). It measures throughput between these devices, not general Internet bandwidth.

## End a session or revoke access {#permissions}

| Your intention                                            | What to do                                                                                                | Result                                                                                   |
| --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Temporarily use the controller locally                    | Press **Ctrl+Alt+Shift+Q**, unless you changed it                                                         | Releases pointer capture and disables keyboard forwarding; keeps the approved connection |
| End remote input                                          | Choose **End control** in the controller's picture actions or the host's control status                   | Ends the current control grant                                                           |
| Stop showing the host's desktop                           | On the host, use **Close screen** for the controlled monitor or stop its screen sharing                   | Stops that monitor's sharing and control                                                 |
| Stop input immediately at the host                        | Press **Ctrl+Alt+Shift+F10**, unless you changed it                                                       | Revokes current remote input and stops related automation input and commands             |
| Prevent future requests from being automatically approved | In **Settings → Clients & rooms**, open the device's permissions and change remote control to Ask or Deny | Changes the saved policy for that device                                                 |

After ending control, check whether screen sharing is still active and stop it if you are finished showing the screen. Leaving the room also ends the current control connection. Disconnecting does not clear a saved allow policy.

Customize release and emergency-stop shortcuts in **Settings → Remote control**; use the combinations currently shown there. [Device permissions](device-trust.md#permissions) explains saved policies and re-pairing.

## Choose your next step {#unavailable}

- **Save what is happening on the remote screen:** follow [recording and saving](recording.md).
- **Choose which devices can control the host without a new prompt:** review [device permissions](device-trust.md#permissions).
- **Members appear but the connection does not complete:** use the [WebRTC connection checks](faq.md#peer-connection).
- **The picture is black, stutters, or has no sound:** follow the [video](faq.md#video) or [audio](faq.md#no-audio) troubleshooting steps.
