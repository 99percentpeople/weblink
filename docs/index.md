---
description: Connect two devices to send a file or control a Windows computer.
outline: 2
---

# Quick start

Choose a first task: [send a file](#connect-two-devices) or [control a computer](#first-remote-session).

## Choose your devices {#choose-your-client}

For chat, files, and calls, open [Weblink](https://webl.ink) in a browser or the desktop app. To control a computer, install the [Windows desktop app](guide/desktop.md) on that computer (**the host**). Your phone, browser, or another desktop app can be **the controller**.

## Connect and send a file {#connect-two-devices}

1. **First device:** open Weblink, choose **Join a room**, enter a name and room ID, then **Connect**.
2. **Other device:** join the same room with the same password if one is set. You can also use the first device's **Account menu → Share Link**.
3. **Sender:** open the chat and send a small file. **Receiver:** select the attachment's transfer action, wait for completion, then open the file.

Keep the sender online until the transfer finishes. Seeing the attachment card alone does not mean the file has downloaded. For the full workflow, see [file transfers](guide/files.md).

## Control a Windows computer {#first-remote-session}

1. **Host:** open the Windows desktop app and join a room. **Controller:** open Weblink and join the same room.
2. **Controller:** select the host's tile, open its picture actions, and choose **Request control**.
3. **Host:** check the requesting device and choose **Allow for this session**.
4. **Controller:** open the shared screen and try moving the pointer. For typing, use **Enable keyboard control** on a computer or **Show keyboard** on a phone.

A request from the participant tile can share **Screen 1 and its audio with all room members**. Approval allows control of the host's mouse and keyboard.

When finished, choose **End control** and stop screen sharing on the host if it remains active. [Remote desktop](guide/remote-control.md) covers selecting a monitor and releasing input.

To approve future requests without someone at the host, configure [unattended access](guide/remote-control.md#unattended).

::: details Using your own server, or wondering where data is saved?

### Connections and local data {#how-connections-work}

Both devices need the same WebSocket signaling server. Leave the default unchanged for ordinary use; for your own service, set the same address on each device in [connection settings](guide/connection.md#signaling).

Messages, files, and media use WebRTC, with TURN relaying when needed. You can [host only the signaling service](deployment/overview.md) and use the existing clients.

Chat history, identity, and permissions stay in the current local profile. They do not sync through an account; rooms do not deliver offline messages or previous history to new members.
:::

## What would you like to do next? {#start-collaborating}

- **Invite people or use private chat:** [rooms and chat](guide/rooms.md).
- **Talk, share a screen, or save a recording:** [screen sharing and calls](guide/media.md) · [recording and saving](guide/recording.md).
- **Choose a save folder or manage device access:** [file storage](guide/storage.md) · [device permissions](guide/device-trust.md).
- **Something does not connect or play:** find the matching symptom in [Troubleshooting](guide/faq.md).
