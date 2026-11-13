# Rooms and chat

Rooms let online devices discover each other. Use the same signaling service, room ID, and password to collaborate in one room.

## Join a room and invite devices {#join}

1. Open Weblink and choose a recognizable display name.
2. Enter a room ID and set a password if you want to restrict entry.
3. Enter the same details on another device, or use the room invitation link or QR code.
4. Wait for the member to appear and device pairing to finish, then send a message to confirm connectivity.

For self-hosted signaling, first choose the same server in **Settings → Connection**. Identical room IDs on different signaling servers do not connect devices together.

Share invitations with the people you want to join. Invitations and display names do not replace device permissions, and joining a room does not automatically grant remote control.

## Room chat and private chat {#chat}

| Conversation        | Recipients                    | Use it for                                                |
| ------------------- | ----------------------------- | --------------------------------------------------------- |
| Room chat           | Currently online room members | Multi-device conversations, messages, and attachments     |
| Member private chat | The selected device           | Private conversations and device-to-device file transfers |

Room messages target online members and do not provide an offline queue. Devices that join later do not automatically receive earlier messages or attachments; resend them to current members when needed.

History stays in the current browser or desktop profile. Switching browsers or computers, or clearing site data, does not restore history from the server.

## Send files and check progress {#attachments}

Choose or drop files into a conversation and confirm sending. Room attachments require recipients to download them by default; seeing an attachment card does not mean its bytes have arrived.

Check progress in transfer tasks. For room files, open details from the menu to inspect each recipient's status. Retry a failed recipient according to that task's state. See [File transfers and sharing](files.md).

## Leave, reconnect, and use multiple windows {#reconnect}

Leaving a room ends its active device connections. After rejoining, devices verify their identity again before saved permissions apply. An ordinary disconnect does not clear local chat or device permissions.

Matching names do not prove that a device is the same. If an identity change or untrusted warning appears, confirm and repair it through [Device pairing and permissions](device-trust.md#repair).

## Choose your next step {#troubleshooting}

- **Send files now that your devices are connected:** learn how to [transfer files and share a file list](files.md).
- **Decide what each device can access:** configure [device pairing and permissions](device-trust.md).
- **Understand delivery acknowledgments and duplicate handling:** explore the [P2P control protocol](../architecture/p2p-protocol.md).
- **Find a missing member or fix messages that will not send:** use the [room and connection FAQ](faq.md#connection).
