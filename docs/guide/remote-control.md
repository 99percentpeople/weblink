---
description: Control a Windows computer from your phone or browser, and end access when finished.
outline: 2
---

# Remote desktop

The **host** is the computer being controlled; the **controller** is the device you use to operate it.

### Before you start {#before-you-start}

Run the [Windows desktop app](desktop.md) on the host. The controller can use a phone browser, computer browser, or desktop app. [Join the same room](rooms.md#join) on both devices.

## Start controlling {#connect}

### Host: share a monitor {#share-monitor}

Choose **Share screen** in the bottom controls, select a monitor, and confirm. Include audio if needed and offered. **Window sharing is view-only**; remote input needs a shared monitor.

### Controller: request access {#request-control}

Select the shared monitor, open its picture actions using the floating button, and choose **Request control**. Use **Cancel request** to withdraw a pending request.

### Host: approve the device {#approve-and-check}

Check the device named in **Allow remote control?**, then choose **Allow for this session**. On the controller, wait for **Controlling** and try moving the pointer.

**Approval allows mouse and keyboard control of the host, not just one application or monitor.** Clicking a system notification only opens the request; choose an approval action to grant access.

::: details Request control before the host shares a screen

Request from the host's participant tile. Approval can start sharing **Screen 1 and its audio with all room members**. To use another monitor, have the host share it first as above.
:::

## Use the mouse, keyboard, or phone {#input}

- **Computer keyboard:** turn on **Enable keyboard control** before typing.
- **Phone:** move one finger and tap to click in trackpad mode. Use **Show keyboard** in the picture actions to type.
- **Return to local input:** press **Ctrl+Alt+Shift+Q** by default. This releases pointer capture and disables keyboard forwarding, while keeping the approved connection.

::: details Pointer capture, touch gestures, and input limits

**Settings → Remote control** contains local-pointer/capture mode, touch speed, scroll direction, long-press actions, and gesture preferences. Keyboard forwarding is separate from pointer capture.

Losing focus releases current input. Restore capture or keyboard forwarding when needed; after the release shortcut, turn keyboard control back on before sending keys.

Operating-system shortcuts, protected screens, and higher-privilege Windows applications may not accept remote input.
:::

## End control and sharing {#permissions}

- Choose **End control** on the controller or in the host's control status.
- To stop showing the desktop too, use **Close screen** on the host or stop its screen sharing.
- For an emergency stop at the host, press **Ctrl+Alt+Shift+F10** by default. This also stops related automation input and commands.

**Ending control may leave screen sharing active.** Check both when finished. Shortcuts can be changed in **Settings → Remote control**; use the combinations shown there.

Saved allow policies remain after disconnection and can approve later requests automatically. To change that, open **Settings → Clients & rooms**, select the device, and set remote control to Ask or Deny. See [device permissions](device-trust.md#permissions).

::: details Copy content or drop files onto the remote desktop

### Clipboard and file drop {#clipboard-and-files}

Both features are off by default and require active control authorization. Enable them in **Settings → Transfers**.

Clipboard types depend on both clients; clipboard files can go to the local clipboard or file library. File drop copies local files into compatible Windows applications, with folders packaged as ZIPs. Dragging files out of the remote view into the controller's operating system is not supported.

The default file limit is 64 MiB, adjustable from 1–512 MiB. Ordinary [file transfers](files.md) do not require remote control.
:::

::: details Fullscreen, picture-in-picture, and picture quality

### Viewing options {#viewing}

Use the picture actions for fullscreen or picture-in-picture. Desktop also supports a native always-on-top window.

Start with automatic encoding. For text, prioritize readable resolution; if the connection struggles, reduce resolution or frame rate. See [sharing quality](media.md#quality) for restart requirements, or [test the connection](connection.md#speed-test).
:::

## Choose your next step {#unavailable}

- **Save the remote screen as a file:** use [recording and saving](recording.md).
- **The connection fails or the picture is black:** follow the [connection](faq.md#peer-connection) or [video](faq.md#video) checks.
