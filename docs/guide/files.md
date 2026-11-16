---
description: Send and receive a file, check each recipient's progress, resume transfers, and share selected files for others to browse.
---

# File transfers and sharing

Send a file in a conversation when you want a specific person or room to receive it. Use a shared file list when you want connected devices to browse and choose files themselves.

## Before transferring {#before-you-start}

1. [Join the same room](rooms.md#join) and confirm a chat message reaches the other device.
2. **On the sender**, keep the source file and its storage location available.
3. **On the receiver**, check [where new files will be saved](storage.md#choose-storage) and authorize directory access if required.
4. Keep both devices online until the transfer finishes. Start with a small file to check the complete sending and saving path.

## Send and receive a file {#send-and-receive}

### On the sender {#send}

1. Open the room chat or the intended member's private chat, and check the conversation title.
2. Choose **Send file**, **Send photos or videos**, or **Send folder**. You can also drop files into the chat or use **Choose from files** for files already in your library.
3. Review the sending confirmation and send. When selecting a folder, follow the prompt to package it as a ZIP.
4. Keep Weblink and the source file available while the recipient downloads. For room attachments, open **View details** to see each recipient separately.

### On the receiver {#receive}

1. Open the same conversation and find the attachment.
2. If it has not started downloading, select the card's transfer action (**Click to transfer** for a room attachment).
3. Watch progress in the card or **Account menu → Tasks**. Wait for **Saving / merging** to finish and the task to show **Completed**.
4. Preview or open the file. To keep a separate copy, use [Save to device or Save as](#save-and-preview).

**Success means:** the receiver has the complete file and can open it with a suitable application. A delivered attachment card only confirms that the file offer arrived. In a room, one recipient finishing does not mean every recipient has downloaded it.

When the app reports **Already on this device; transfer skipped**, it has reused available local content instead of downloading it again. Devices joining later do not automatically receive old attachment offers.

## Automatically receive small room files {#automatic-downloads}

Room attachments require a transfer request by default. To receive new small attachments automatically:

1. **On the receiving device**, open **Room information and settings** from the room heading or room conversation menu, then select **Room settings**.
2. Set **Allow automatic file downloads** to **Allow** for that room.
3. In **Settings → Transfers**, choose the **Automatic download size limit**.
4. Ask the sender to send a new file within that limit and confirm its transfer completes without clicking the card.

The size limit is shared by all rooms that allow automatic downloading. Larger files remain available for manual transfer, and enabling this setting does not download old attachments.

**Automatic download** in the transfer settings is a separate option for saving after reception. It does not replace the room's permission to start receiving files automatically.

## Pause, resume, or stop a task {#tasks}

Open **Account menu → Tasks** and find the file by name and peer. Use the controls offered for its current state.

| Task state or intention                     | Action                                                               |
| ------------------------------------------- | -------------------------------------------------------------------- |
| A transfer is running and you want to pause | Choose **Pause**; keep the source and received data available        |
| A paused or failed transfer can continue    | Reconnect the devices, then use the available resume or retry action |
| A queued task should not start              | Cancel it from the task or attachment controls                       |
| A task offers a stop/cancel action          | Use that action to stop the task; closing the panel does not stop it |

After a disconnect, return to the original room for a room attachment, confirm the sender is online, and keep the original source and receiving directory accessible. Recoverable received data can be reused when you resume.

Leaving the room interrupts its active connections. For a transfer that still cannot continue, follow the [file availability checks](faq.md#file-unavailable).

## Let others browse a shared file list {#shared-files}

### On the device providing files {#share}

1. Open **Account menu → File Cache**. This is the local file library.
2. Import the files you want to offer, or select complete files already listed, then choose **Share**.
3. In **Settings → Clients & rooms**, select the receiving device and allow **Provide file list**.

Importing or receiving a file does not share it automatically. Newly sent files are shared automatically; you can later select **Stop sharing**. Selecting a storage directory does not expose every file in it.

The shared list belongs to this device and is used **across rooms**. Each connected device still needs file-list permission to browse it; it is not a separate list for each room.

### On the device receiving files {#browse-shared}

1. Open **People** and choose **Shared files** beside the providing device.
2. Search or sort the list, select a file, and choose **Get**, or select several and choose **Get selected**.
3. Follow the downloads in **Tasks**, then open completed files in **File Cache**.

**Success means:** the receiver can see the selected files and complete a download. Shared-list downloads do not create extra chat messages. Stopping sharing does not delete copies the other device has already saved.

## Where received files are stored {#storage}

Browsers default to storage for the current site; desktop defaults to a local file directory. **Settings → Transfers → File storage** selects the location for new files.

Changing the default does not move old files, active transfers, or recordings. See [file storage and management](storage.md) to select a directory, restore access, or find older files.

## Preview and save a copy {#save-and-preview}

Open the completed file's actions from its attachment or **File Cache**.

| Where the file is stored | Action                                                                    |
| ------------------------ | ------------------------------------------------------------------------- |
| Browser storage          | **Save to device** exports a copy                                         |
| Local directory          | **Save as…** creates a copy elsewhere and keeps the original              |
| Windows directory        | **Open file location** reveals the actual file in the system file manager |

Desktop can also open supported files in their system default applications. In-app preview availability depends on the file type and runtime.

For batch saving, select the files and use the available save action. Batch **Save as…** asks for one destination directory; resolve name conflicts by overwriting, skipping, or keeping both copies. Cancelling stops subsequent files and keeps completed copies. Closing the file manager does not cancel background saving.

## Choose your next step {#troubleshooting}

- **Set a default directory or free up storage:** follow [file storage and management](storage.md).
- **Measure this connection before a large transfer:** run a [peer speed test](connection.md#speed-test).
- **Understand chunks, resume, and integrity checks:** read the [file transfer protocol](../architecture/file-transfer.md).
- **An attachment is unavailable or saving fails:** use the [file and storage FAQ](faq.md#files).
