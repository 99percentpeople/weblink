---
description: Send a file, receive it completely, or let another device browse selected shared files.
outline: 2
---

# File transfers and sharing

Send files in a chat, or share a list for other devices to browse.

### Before transferring {#before-you-start}

[Connect the devices](rooms.md#join). Keep the sender online with the source file available, and check the receiver's [save location](storage.md#choose-storage).

## Send and receive a file {#send-and-receive}

### Sender {#send}

Open the room chat or a member's private chat, choose **Send file** or drop a file into it, and confirm the intended conversation before sending.

### Receiver {#receive}

Select the attachment's transfer action (**Click to transfer** for a room attachment). Wait for **Saving / merging** to finish, then open the completed file. Progress is also available in **Account menu → Tasks**.

**An attachment card is a file offer, not a completed download.** In a room, each recipient downloads separately. **Already on this device; transfer skipped** means available local content was reused.

::: details Folders, files already in your library, and automatic reception

Use **Send folder** to package a folder as a ZIP, or **Choose from files** for an existing library file.

### Automatically receive small room files {#automatic-downloads}

On the receiver, open **Room information and settings → Room settings**, set **Allow automatic file downloads** to **Allow**, then choose the limit in **Settings → Transfers → Automatic download size limit**.

This applies to new files in that room; it does not download history. The limit is shared by all enabled rooms, and larger files can still be requested manually.

The separate **Automatic download** transfer setting saves files after reception; it does not authorize automatic room-file reception.
:::

::: details Pause, resume, or check each recipient

### Transfer tasks {#tasks}

Open **Account menu → Tasks** and use the pause, resume, retry, or cancel action offered for the current state. For a room file, **View details** shows each recipient's progress.

After disconnecting, return to the original room with the sender online and both storage locations available, then resume. Recoverable received data can be reused. Closing the task or file panel does not stop a transfer; leaving the room interrupts its connection.
:::

## Share a browsable file list {#shared-files}

### On the device providing files {#share}

Open **Account menu → File Cache**, select complete files, and choose **Share**. In **Settings → Clients & rooms**, allow **Provide file list** for the receiving device.

### On the receiving device {#browse-shared}

In **People**, choose **Shared files** beside the provider. Select files and choose **Get** or **Get selected**; follow progress in **Tasks** and open completed files in **File Cache**.

The list is shared **across rooms**, with access controlled per device. Newly sent files are shared automatically; importing or receiving does not share them. **Stop sharing** does not delete copies already saved by others.

## Keep a copy {#save-and-preview}

From the completed attachment or **Account menu → File Cache**:

- **Save to device** exports a browser-stored file.
- **Save as…** copies a directory file elsewhere.
- On Windows, **Open file location** reveals the actual file.

### Default save location {#storage}

Change it in **Settings → Transfers → File storage**. This affects new files; existing files and active tasks stay in their original location. See [file storage](storage.md).

::: details Save several files together

Select the files and use the available save action. Batch **Save as…** asks for one destination; for name conflicts, choose overwrite, skip, or keep both. Cancelling stops subsequent files and preserves completed copies. Closing the file manager does not cancel background saving.
:::

## Choose your next step {#troubleshooting}

- **Choose a folder or free storage:** follow [file storage and management](storage.md).
- **Measure this device connection:** run a [peer speed test](connection.md#speed-test).
- **A file is unavailable or saving fails:** use the [file and storage FAQ](faq.md#files).
