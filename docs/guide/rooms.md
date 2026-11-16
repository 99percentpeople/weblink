---
description: Join the same room, invite another device, choose room or private chat, and reconnect without confusing local history with live delivery.
---

# Rooms and chat

Use a room to bring online devices together, then choose whether to talk to everyone or one device. This guide takes you from joining to confirming your first message.

## Before you join {#before-you-start}

- Open [Weblink](https://webl.ink) or the desktop app on each device.
- Choose the same **WebSocket URL, room ID, and room password** on both sides. A display name identifies you in the interface; it does not have to match.
- For self-hosted signaling, set the address on each device in [connection settings](connection.md#signaling) first. The same room ID on different signaling servers does not connect the devices.

You can leave the password empty if the room does not use one. If it does, every participant needs that password.

## Join a room and confirm the connection {#join}

1. **On the first device**, choose **Join a room**. In the setup dialog, enter a recognizable name, continue to the room information, and enter the room ID and optional password.
2. Choose **Connect**. Editing the fields saves the configuration; it does not join the room until you connect.
3. **On the other device**, use the same room information, or [open an invitation](#invite). Choose a name that lets you distinguish this device.
4. On both devices, open **People**, find the other member, and wait for connection and [pairing](device-trust.md#pairing) to finish.
5. [Open a conversation](#chat), send a short message, and have the recipient confirm it arrived.

For a previous room, select it from **Recent rooms** and choose **Connect**. Use **Edit room information** when you need to change the saved details.

**Success means:** both devices see each other and the recipient receives your test message. A room member appearing is only the first step; use the [connection FAQ](faq.md#connection) if message delivery does not work.

## Invite another person or device {#invite}

1. **On a device in the room**, open the avatar's **Account menu**.
2. Choose **Share Link** to copy an invitation, or **Room QR code** for the other device to scan. The QR dialog also offers **Copy Link**.
3. **On the invited device**, open the link, check the room details, and join. Confirm its name appears on the original device.

The invitation contains the room ID and the password if one is set. Give it to the people you intend to invite. It does **not** carry a custom WebSocket URL: users of a self-hosted service must still select the same server themselves.

The optional **Share Servers with Others** connection setting concerns STUN/TURN entries and can include their credentials in the link. See [server sharing](connection.md#share-settings) before enabling it. An invitation does not grant remote control or other device permissions.

## Choose room chat or private chat {#chat}

1. Open **People** in the meeting interface.
2. For room chat, select the current room's row (**Open current room chat**). For a private conversation, select the other member's name (**Chat with…**).
3. Check the conversation title before composing a message.
4. Type a message and choose **Send**. On the recipient's device, open the corresponding conversation to confirm receipt.

| Conversation | Who receives new messages?                    | Typical use                                      |
| ------------ | --------------------------------------------- | ------------------------------------------------ |
| Room chat    | Connected, online members of the current room | Discuss something with all participating devices |
| Private chat | The selected device                           | Send a message or file to one recipient          |

Room messages do not provide an offline queue. A device that joins later does not automatically receive earlier messages or attachment offers; resend what it needs after it is connected.

## Send an attachment and check delivery {#attachments}

In the conversation, choose **Send file**, **Send folder**, or **Choose from files**, or drop a file into the chat. Check the intended recipient in the sending confirmation before proceeding.

A room attachment card announces the file; recipients normally need to request its transfer. The sender must stay online and keep the source file available. Use **View details** on the room file to see each recipient's progress, or open **Account menu → Tasks**.

**A delivered message is not a completed file transfer.** Continue with the [sender and receiver steps](files.md#send-and-receive) to download, verify, and save the file.

## Understand what history is kept {#history}

Chat history belongs to the current browser or desktop profile. It is not a server backup and does not follow you to a different browser or computer.

- Leaving a room keeps local history and device permissions.
- Removing a room from **Recent rooms** clears that shortcut and its saved password, while keeping chats and permissions.
- **Clear chat history** removes local conversation records. File cleanup is a separate operation; see [file deletion and storage](storage.md#cleanup).
- Clearing browser site data can remove history, device identity, settings, and browser-stored files.

The room's **Previous members** list only includes earlier participants whose private conversation remains saved locally. It is not an indication that those devices are currently online.

## Leave, reconnect, or switch pages {#reconnect}

1. Finish the transfers and recordings you want to keep, then choose **Leave room**.
2. To return, select the saved room and connect again. Devices verify identity before reusing saved permissions.
3. Send a message to confirm the new connection. A matching display name alone does not verify a device; follow [pairing repair](device-trust.md#repair) if its identity has changed.

Within the same browser profile and site, one identity connects to a room from one page at a time. If you open it in another page, **Switch to this page** moves the connection there and ends the previous page's meeting and transfers. To represent two separate devices for a test, use two devices or separate browser profiles.

## Choose your next step {#troubleshooting}

- **Send a file and make sure it finishes downloading:** follow [file transfers and sharing](files.md).
- **Start a call or show your screen to the room:** use [screen sharing and calls](media.md).
- **Decide which devices can access your files or control your computer:** review [device permissions](device-trust.md#permissions).
- **A member does not appear or messages do not arrive:** follow the [connection checks](faq.md#connection).
