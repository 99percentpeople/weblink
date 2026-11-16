---
description: Connect two devices, send your first file, or control a Windows computer from your phone or browser.
---

# Quick start

Weblink connects devices for chat, file transfers, calls, screen sharing, and remote desktop. Start with the task you want to complete:

- **Send a file or start a conversation:** [connect two devices](#connect-two-devices). Both can use a browser.
- **Operate a Windows computer from your phone or another computer:** [start remote control](#first-remote-session). Install the desktop app on the computer you want to control.

## Choose what to open on each device {#choose-your-client}

| Your task                  | First device                                         | Other device                                                    |
| -------------------------- | ---------------------------------------------------- | --------------------------------------------------------------- |
| Chat or transfer files     | Browser or desktop app                               | Browser or desktop app                                          |
| Make a voice or video call | Browser or desktop app with microphone/camera access | Browser or desktop app with microphone/camera access            |
| Control a Windows computer | **Host:** Windows desktop app                        | **Controller:** phone browser, computer browser, or desktop app |

The **host** is the computer being operated; the **controller** sends mouse, touch, and keyboard input. A browser can control a supported host, but cannot receive remote input to operate its own computer. See [desktop installation and requirements](guide/desktop.md) before setting up a host. Browser capture features need a supported browser, HTTPS or localhost, and system permissions.

## Connect two devices and send a file {#connect-two-devices}

1. **On the first device**, open [webl.ink](https://webl.ink) or launch the desktop app. Set a display name and room ID, optionally add a room password, and join the room.
2. **On the other device**, open Weblink and join with the same **WebSocket URL, room ID, and password**. If both devices use the default service, leave the connection settings unchanged. You can also use the room's invitation link or QR code.
3. **On both devices**, wait for the other member to appear and for the connection and device pairing to finish. Send a short message and confirm it appears on the other device.
4. **On the sender**, attach a small file to the chat and send it. **On the receiver**, use the file message's download action if it has not downloaded automatically, then wait for the transfer to complete.
5. **On the receiver**, open or preview the completed file. To keep a copy outside Weblink's browser storage, use **Save to device** from the file's actions.

**You are connected when:** the other device receives your message and can open the transferred file. Seeing a member in the room alone does not confirm that the WebRTC connection works. If this check fails, follow [connection troubleshooting](guide/faq.md#connection).

The [file transfer guide](guide/files.md) covers larger transfers and shared file lists; [file storage](guide/storage.md) explains local-directory saving.

## Start your first remote session {#first-remote-session}

1. **On the host**, [install and open the Windows desktop app](guide/desktop.md). Keep it running and join a room.
2. **On the controller**, open Weblink in a browser or desktop app and [join the same room](#connect-two-devices). You do not need to install the desktop app on a phone.
3. **On the controller**, select the host's tile in the meeting area, open its picture actions, and choose **Request control**. On the main view, the actions open from the floating button.
4. **On the host**, check the device named in **Allow remote control?** and choose **Allow for this session**. A request that starts screen sharing shares **Screen 1 and its audio with all room members**, as stated in the prompt.
5. **On the controller**, open the shared monitor. Confirm the status says **Controlling** and try moving the pointer. On a computer, turn on **Enable keyboard control** before typing; on a phone, use **Show keyboard** in the picture actions.
6. When finished, choose **End control**. If the host is still sharing its screen, stop sharing there too.

**You are ready when:** the controller sees the host's desktop and its input changes the host's pointer or application. Screen viewing alone does not grant input permission. The [remote desktop guide](guide/remote-control.md#connect) covers choosing a monitor, touch gestures, releasing input, and revoking access.

## Connections and saved data {#how-connections-work}

Devices must use the same signaling service to find each other. Messages, files, and media travel over WebRTC; some networks need a TURN relay. If the default WebSocket service is slow or unreachable, use the [connection FAQ](guide/faq.md#signaling-mainland). You can also [host only the signaling service](deployment/overview.md) and change the WebSocket URL in the existing client.

Chat history, device identity, and permissions are saved in the current local profile. They do not sync through an account, and rooms do not deliver offline messages or earlier history to new members. Joining a room does not automatically authorize remote control or automation.

## What would you like to do next? {#start-collaborating}

| I want to…                                                   | Continue with                                                                              |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------ |
| Invite someone or switch between room chat and private chat  | [Rooms and chat](guide/rooms.md)                                                           |
| Share a file list or choose where received files are stored  | [File transfers](guide/files.md) and [file storage](guide/storage.md)                      |
| Talk, turn on a camera, or share a screen                    | [Screen sharing and calls](guide/media.md)                                                 |
| Record a screen or camera source and find the saved file     | [Recording and saving](guide/recording.md)                                                 |
| Use a phone, keyboard, or clipboard during remote control    | [Remote desktop](guide/remote-control.md#input)                                            |
| Change servers, test a connection, or manage trusted devices | [Connection settings](guide/connection.md) and [device permissions](guide/device-trust.md) |
| Connect an MCP client after setting up the devices           | [MCP and automation](guide/automation.md) (advanced)                                       |
| Understand the design or run my own services                 | [Architecture](architecture/overview.md) and [self-hosting](deployment/overview.md)        |
