---
description: Choose where received files and recordings are saved, find existing files, restore directory access, and remove files you no longer need.
---

# File storage and management

Choose where new received files and recordings are written, then manage them through **Account menu → File Cache**. The interface calls this **File Cache**, but files in a local directory are real files in that directory.

Chat history, device identity, and permissions are separate data. Choosing a directory for files does not move those records into it.

## Choose a save location {#choose-storage}

| What you need                         | Storage method                  | What it means                                                                                                 |
| ------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Start without choosing a folder       | **Browser storage** (IndexedDB) | Files belong to the current site/profile and use its storage quota                                            |
| Write directly to a folder you manage | **Local directory**             | Available in desktop and browsers that support directory access; files are visible in the system file manager |

Browsers default to browser storage. Desktop defaults to a directory under the application's local data and can use another location. Browser directory access requires a secure context such as HTTPS and your authorization.

1. Open the avatar's **Account menu → Settings → Transfers → File storage**.
2. Under **Storage method**, choose **Browser storage** or **Local directory**.
3. For a local directory, choose **Choose a directory**, select the destination, and grant access when prompted.
4. Confirm the method and displayed directory before starting a new transfer or recording.
5. Receive a small file, wait for completion, and open **Account menu → File Cache** to find it. On desktop, **Open directory** can also show the directory in the system file manager.

**Success means:** a new completed file appears in the selected storage location. Selecting a directory does not itself copy existing files into it or share its contents with other devices.

## Change locations and restore access {#change-directory}

### Put future files in another location {#switch-location}

1. Return to **Settings → Transfers → File storage**.
2. Choose **Local directory → Choose a directory** for a different folder, or select **Browser storage**.
3. Check the displayed destination, then start a new transfer or recording to verify it.

The change applies to **new files**. Existing files, unfinished transfers, and recordings that have already started keep their original location. A batch **Save as…** also creates copies without changing the default.

To browse older files in **File Cache**, select their original storage location again. This also changes where subsequent new files go; restore your preferred default after viewing if needed. On desktop, the file library's **Open directory** menu can open previously mounted directories in the system file manager without changing the default.

### Reauthorize a browser directory {#restore-access}

1. Open the file-storage settings and check that the intended directory is selected.
2. If **Reconnect directory** appears, choose it and grant access in the browser prompt.
3. Keep any removable drive connected, then reopen **File Cache** and try opening a known file.

Browsers may require authorization again after reopening the page. Reauthorizing an existing directory does not require clearing site data. If access or writing still fails, follow the [storage checks](faq.md#storage-full).

## Find and manage files {#library}

1. Open **Account menu → File Cache**.
2. Search by name, then use **Availability**, **File type**, or **Sort** to narrow the list.
3. Choose an available, complete file and open its **File actions**. **Details** shows names and related attachment references.
4. Choose the action that matches your purpose:

| Your purpose                           | Action                                                       |
| -------------------------------------- | ------------------------------------------------------------ |
| Inspect the contents                   | Preview, or open with a supported application                |
| Keep a copy outside browser storage    | **Save to device**                                           |
| Copy a directory file elsewhere        | **Save as…**                                                 |
| Locate a Windows directory file        | **Open file location**                                       |
| Offer a selected file to other devices | **Share**, with the recipient's file-list permission enabled |

The selected directory's existing files are listed without first being copied into another cache. Hidden files and browser temporary files are not listed as ordinary files. Newly received files with name conflicts preserve the existing file and use numbered names.

An incomplete directory transfer typically has a `.part` suffix. Wait for its task to finish before treating it as a complete file. Full export and batch-copy steps are in [saving copies](files.md#save-and-preview); sharing selected files is covered in [shared file lists](files.md#shared-files).

## Delete files and free space {#cleanup}

1. Open **File Cache** and find the files you no longer need.
2. For anything you want to keep, use **Save to device** or **Save as…** first and check the copy.
3. Open **Details** if you need to check which attachments refer to a file.
4. Choose **Delete local file**, read the confirmation about affected attachment references, and confirm only the files you intend to remove.

Deleting a local-directory file removes the actual file, including when you delete it through the system file manager. Chat messages can remain even though their attachment content is no longer available. Clearing a chat and deleting the underlying file are different operations.

Turning off sharing only changes access; it does not free storage. Clearing all browser site data can also remove browser-stored files, history, identity, and settings. Export anything you need before doing that.

Clearing app settings does not automatically delete bytes in real directories, but directory access, chat references, and sharing settings may need to be established again.

## Let an upgrade finish storage migration {#migration}

An upgrade may migrate older browser file storage automatically.

1. Keep the app or page open while the file count and copy/verification progress advance.
2. Wait for the migration to finish before clearing old browser data.
3. Open **File Cache** and check a few files you need to keep.

Closing the file panel does not stop migration. This upgrade migration is separate from choosing a new default directory, which does not move your existing files.

## Choose your next step {#troubleshooting}

- **Let another device browse selected files:** follow [shared file lists](files.md#shared-files).
- **Record a screen and find the resulting file:** use [recording and saving](recording.md).
- **A file is missing or a save fails:** use the [file and storage FAQ](faq.md#files).
- **Understand partial files and when data is removed:** read the [storage lifecycle](../architecture/storage.md).
