---
description: Join a room, invite another device, and start a room or private conversation.
outline: 2
---

# Rooms and chat

Use the same room ID and password on both devices. A recognizable display name helps you tell them apart.

## Join a room {#join}

1. Choose **Join a room**, enter your name and room information, then **Connect**.
2. Join from the other device using the same room details or an invitation.
3. Open **People**, wait for the other device to connect, and send it a message.

When the other device receives the message, you can start collaborating. If it does not arrive, use the [connection checks](faq.md#connection).

::: details Joining a previous room or using your own server

### Connection details {#before-you-start}

Select a previous room from **Recent rooms** and choose **Connect**. Use **Edit room information** to change its saved details.

For a self-hosted service, configure the same WebSocket URL on each device in [connection settings](connection.md#signaling). Room invitations do not include a custom WebSocket URL.

The optional **Share Servers with Others** setting concerns STUN/TURN entries and their credentials; see [sharing connection settings](connection.md#share-settings).
:::

## Invite someone {#invite}

Open the avatar's **Account menu → Share Link**, or choose **Room QR code** for the other device to scan. The recipient opens the invitation and joins the room.

The link includes the room password if one is set, so share it with the intended participants. Joining does not grant remote control or other [device permissions](device-trust.md#permissions).

## Chat with everyone or one device {#chat}

In **People**, select the current room's row for room chat, or a member's name for private chat. Check the conversation title, type your message, and choose **Send**.

Room messages go to connected, online members. Devices joining later do not receive previous messages or attachment offers; resend anything they need.

### Send a file {#attachments}

Choose **Send file** in the conversation. The recipient normally needs to select the attachment's transfer action, and the sender must remain online. Follow [file transfers](files.md#send-and-receive) for progress and saving.

## Leave and return {#reconnect}

Finish transfers and save recordings, then choose **Leave room**. To return, select the room and connect again. Local history and saved permissions remain; identity is checked again before permissions apply.

::: details Local history and using more than one page

### What stays on this device {#history}

History belongs to the current browser or desktop profile, with no account sync or server backup.

- Removing a **Recent rooms** entry clears its shortcut and saved password, while keeping chats and permissions.
- **Clear chat history** removes local conversation records; [deleting files](storage.md#cleanup) is a separate action.
- Clearing site data can remove browser-stored files, history, identity, and settings.
- **Previous members** lists earlier participants whose private conversations remain locally; it does not mean they are online.

Within the same browser profile and site, an identity can connect to a room from one page at a time. **Switch to this page** ends the previous page's meeting and transfers. Use separate devices or browser profiles to test two independent clients.

If a device's identity changes, confirm it through [pairing repair](device-trust.md#repair); a matching name alone is not proof.
:::

## Choose your next step {#troubleshooting}

- **Send files or let someone browse selected files:** use [file transfers and sharing](files.md).
- **Talk or show your screen:** follow [screen sharing and calls](media.md).
- **Choose what another device may access:** review [device permissions](device-trust.md#permissions).
