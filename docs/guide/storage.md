# File storage and management

File storage settings choose where new received files and recordings are saved. Chat history, device identity, and permission records are separate data; selecting a real directory does not move those settings into it.

## Choose storage {#choose-storage}

Open **Settings → Transfer → File storage**, choose the storage method, then select a directory if needed.

| Method                      | Clients                                             | Behavior                                                                                             |
| --------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Browser storage (IndexedDB) | Browsers and desktop                                | No directory selection; files belong to the current app profile and are subject to storage quotas    |
| Local directory             | Desktop and browsers supporting directory selection | Files are written directly to the selected directory and can be managed with the system file manager |

Browsers default to IndexedDB. Desktop defaults to a file directory under the application's local data and can use another location.

Browser directory selection needs a secure context such as HTTPS and user authorization.

## Change directories and restore access {#change-directory}

1. In local-directory mode, use the directory picker to select a new location.
2. Confirm the displayed location before receiving new files or starting a recording.
3. Switch back to the previous storage location to browse older files.

The change affects only new files. Existing files and active tasks keep their original location. Batch “Save as” creates copies without changing the default directory.

A browser may need authorization again after reopening the page. When a directory is unavailable, use its reconnect action and grant access; also check that removable drives are connected. Restoring permissions does not require clearing site data.

## Use the file library {#library}

Existing files in the selected directory appear in the library without being copied into a separate cache. Hidden files and browser temporary files are not listed as ordinary files.

- File menus offer preview, open, save as, or save to device, depending on storage.
- For Windows directory files, “Open file location” reveals the file in the system file manager.
- Received files with conflicting names preserve existing files and use numbered names.
- Incomplete directory transfers typically have a `.part` suffix. Do not treat them as complete files before receiving finishes.

Sharing is explicit and also depends on the other device's file-list permission. Mounting a directory does not share all its contents. See [File sharing](files.md#shared-files).

## Delete files and free space {#cleanup}

Deleting a directory file in the file manager deletes the actual file. Removing a chat attachment reference is different from deleting its underlying file; check the location and whether you need a copy before proceeding.

Clearing browser site data affects browser-stored files, chat, and device settings. Save files you need to keep to the device first. Clearing app settings does not automatically delete bytes in real directories, but directory access, chat references, and sharing settings may need to be established again.

## Storage migration after an upgrade {#migration}

After an upgrade, older browser file storage may migrate automatically. The app displays file counts and copy/verification progress. Closing the file panel does not stop migration.

## Choose your next step {#troubleshooting}

- **Let other devices browse files you select:** set up a [shared file list](files.md#shared-files).
- **Save a screen or video source as a recording:** follow the [recording steps](media.md#recording).
- **Understand partial-file recovery and when data is deleted:** explore the [storage lifecycle](../architecture/storage.md).
- **Recover access to an unreadable file or investigate a save failure:** check the [file access and saving FAQ](faq.md#files).
