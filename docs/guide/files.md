# File transfers and sharing

Send files from chat or let another device browse files you explicitly share. Files travel over the WebRTC connection between devices; the sender must remain online.

## Send and receive {#send-and-receive}

1. Join a room, then choose or drop files into room chat or a member's private chat.
2. Review the sending confirmation. When selecting a folder, follow the prompt to package it as a ZIP.
3. Check the transfer task after sending. Recipients download from the attachment card and follow its progress.
4. Once complete, preview, open, or save the file from the library or attachment menu.

Room attachments require recipients to download them by default. To receive small files automatically, the recipient can enable automatic downloads in that room's settings and adjust the size limit in **Settings → Transfer**.

Message delivery means the recipient received the message or attachment information. Check transfer progress to know whether the file itself has downloaded. Members joining later do not automatically receive earlier attachments.

## Pause, resume, and retry {#tasks}

In the task list, use pause, resume, retry, or cancel as available for the current state. A room file's menu offers details with progress for each recipient.

After a disconnect, keep the original file and storage directory available, reconnect, and resume or retry. Recoverable received data can be reused.

Closing the file panel does not cancel an active transfer. Stop it through the task controls; leaving the room interrupts active device connections.

## Use shared file lists {#shared-files}

1. Select complete files in your local library and enable sharing.
2. Allow “Provide file list” in the other device's permission settings.
3. The other device opens your member file panel to search, sort, preview, or download files in bulk.

Importing or receiving a file does not share it automatically. Newly sent files are shared automatically and can be unshared later in the library. Choosing a storage directory does not expose every file in it.

Downloads from a shared list appear in the library and task list without creating an extra chat message. Turning off sharing does not remotely delete copies the recipient already saved.

## Where files are stored {#storage}

Browsers default to storage for the current site; desktop defaults to a local file directory. To change where new files go, choose a storage method and directory in **Settings → Transfer → File storage**.

Changing the default does not move existing files, active transfers, or recordings. See [File storage and management](storage.md) for configuration, directory permissions, and cleanup.

## Preview and save copies {#save-and-preview}

Preview complete files from attachments or the library. Desktop can open files in their system default applications and reveal directory files through the file menu.

- For browser-stored files, use “Save to device”.
- For directory files, use “Save as”; the original remains in place.
- A batch save asks for one destination directory. For name conflicts, overwrite, skip, or keep both copies.
- Cancelling a batch stops subsequent files and keeps completed copies. Closing the file manager does not cancel background saving.

## Choose your next step {#troubleshooting}

- **Save received files in a directory you choose:** configure the [file storage location](storage.md#choose-storage).
- **Measure the connection between two devices:** run a [connection speed test](connection.md#speed-test).
- **Understand how chunks, resume, and integrity checks work:** read the [file transfer protocol](../architecture/file-transfer.md).
- **Resolve unavailable attachments, failed downloads, or slow saves:** check the [file and storage FAQ](faq.md#files).
