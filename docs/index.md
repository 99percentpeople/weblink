---
description: Connect devices for chat, file transfers, audio, video, and remote desktop.
---

# Quick start

Weblink connects devices with WebRTC for chat, file transfers, audio, video, and remote desktop. Use a browser directly or install the Windows desktop app.

## Connect two devices {#connect-two-devices}

1. Open [webl.ink](https://webl.ink) or launch the desktop app on the first device.
2. Set a display name and room ID, adding a room password if you want to restrict entry.
3. Join from the second device using the same **signaling service, room ID, and password**, or use the invitation link or QR code.
4. Wait for connection and pairing, send a message, and try transferring a file.

If members appear but content cannot be sent, start with [connection troubleshooting](guide/faq.md#connection). Joining a room does not automatically grant remote control or OS automation permissions.

## Choose a client {#choose-your-client}

| What you want to do                                | Client choice                                            |
| -------------------------------------------------- | -------------------------------------------------------- |
| Chat, transfer files, or use camera and microphone | Browser or desktop                                       |
| Control a computer from a phone                    | Phone browser as controller, Windows desktop app as host |
| Native screen sharing and incoming remote input    | Windows desktop app                                      |
| Connect an HTTP MCP client and run OS automation   | Windows desktop app                                      |

See [Desktop app](guide/desktop.md) for installation and requirements. Browser media features generally need HTTPS or localhost and the appropriate system permissions.

## Start using features {#start-collaborating}

| Task                                                 | Guide                                                      |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| Invite devices, use room chat and private chat       | [Rooms and chat](guide/rooms.md)                           |
| Send files and share a file list                     | [File transfers and sharing](guide/files.md)               |
| Choose a storage directory and manage existing files | [File storage and management](guide/storage.md)            |
| Voice, video, sharing, and recording                 | [Audio, video, and recording](guide/media.md)              |
| Control a computer with mouse, keyboard, or phone    | [Remote desktop](guide/remote-control.md)                  |
| Adjust device permissions and repair pairing         | [Device pairing and permissions](guide/device-trust.md)    |
| Connect an MCP client                                | [MCP and automation](guide/automation.md)                  |
| Change connection settings and test speed            | [Connection settings and speed tests](guide/connection.md) |

## Connections and saved data {#how-connections-work}

Signaling helps devices discover each other. Messages, files, and media use WebRTC, with TURN relaying when the network prevents a direct connection. To understand the roles of clients, signaling, and relays, read the [architecture overview](architecture/overview.md). To use your own services, choose what to deploy in the [self-hosting overview](deployment/overview.md).

Chat history, device identity, and permissions belong to the current local profile and do not automatically sync through an account. Rooms serve online members without offline delivery or history sync for new members.
