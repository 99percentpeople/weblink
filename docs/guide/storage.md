---
description: Choose a save folder, find your files, and safely remove files you no longer need.
outline: 2
---

# File storage and management

Manage files through **Account menu → File Cache**. Despite that name, local-directory files are real files in the selected folder. Chat history, identity, and permissions are stored separately.

## Choose where new files go {#choose-storage}

1. Open **Account menu → Settings → Transfers → File storage**.
2. Choose **Browser storage**, or **Local directory → Choose a directory** and grant access.
3. Check the displayed location, receive a small file, and find it in **File Cache**.

Browsers default to browser storage; desktop defaults to a local app-data directory. Choosing a directory in a browser requires support for directory access, HTTPS or another secure context, and your permission.

**Changing the location affects new files only.** Existing files, unfinished transfers, and active recordings keep their original location. Selecting a directory does not share it.

## Find and save files {#library}

In **File Cache**, search by name or filter by availability and file type. Open a complete file to preview it, or use its **File actions**:

- **Save to device** exports a browser-stored file.
- **Save as…** copies a directory file elsewhere.
- **Open file location** reveals a Windows file; **Details** shows its attachment references.

Existing directory files appear without being copied into another cache. Incomplete transfers may have a `.part` suffix; wait for the task to finish. More options are in [saving copies](files.md#save-and-preview).

## Delete files and free space {#cleanup}

1. Save and check a copy of anything you want to keep.
2. In **File Cache**, select an unwanted file and choose **Delete local file**.
3. Read the affected-attachment notice before confirming. Use **Details** first if you need to inspect references.

**Deleting a directory file deletes the actual file.** Its chat messages may remain with unavailable attachments. **Stop sharing** only changes access and does not free space.

::: details Switch folders, find older files, or restore directory access

### Changing storage locations {#change-directory}

#### Select another location {#switch-location}

Return to **Settings → Transfers → File storage** and choose a different directory or browser storage.

To see older files in **File Cache**, select their original location again. This also changes the destination for new files; restore your preferred default afterward. On desktop, **Open directory** can open previously mounted folders in the system file manager without changing the default.

#### Reauthorize a browser directory {#restore-access}

If **Reconnect directory** appears in the storage settings, select it and grant access. Keep removable drives connected, then try opening a known file. Reauthorizing does not require clearing site data.
:::

::: details Browser storage, clearing data, and upgrade migration

Browser-stored files use the current site's storage quota. Clearing site data can remove these files, chat, identity, and settings, so export needed files first.

Clearing app settings does not automatically delete files in real directories, but access and sharing settings may need to be restored.

### Migration after an upgrade {#migration}

Older browser storage may migrate automatically. Keep the page open until copying and verification finish, then check your files. Closing the file panel does not stop migration. This is separate from selecting a new default folder, which does not move existing files.
:::

## Choose your next step {#troubleshooting}

- **Let another device browse selected files:** set up [file sharing](files.md#shared-files).
- **Record a screen and find its file:** follow [recording and saving](recording.md).
- **A file is missing or saving fails:** use the [file and storage FAQ](faq.md#files).
