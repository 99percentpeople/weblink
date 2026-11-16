---
description: Record one screen or camera source, pause and finish the recording, then find, preview, or export the saved file.
---

# Recording and saving

Record one local or received video source and its associated audio. The result is a file on the device that starts recording; it is not a combined recording of every participant or an automatic copy on the other devices.

## Prepare the source and save location {#prepare}

1. Start a [camera or screen share](media.md), or open a video source received from another device. Confirm you can see the intended picture and that the source includes any audio you need.
2. On the device that will record, open **Settings → Transfers → File storage** and check the destination. Authorize directory access if requested.
3. In **Settings → Audio & video → Recording**, keep **Auto** for the first recording, or [choose a format](#formats).
4. Make a short recording first and check the saved file on the player you plan to use.

| Storage choice              | Where the recording goes                                                                                             |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Browser storage (IndexedDB) | Weblink's storage for the current browser profile; export a copy with **Save to device** to keep it outside the site |
| Local directory             | The selected directory; desktop uses a local app-data directory by default and supports choosing another location    |

Recording keeps the storage location selected when it starts. Switching the default directory during a recording does not move the active file. Directory authorization and available space still matter; see [file storage](storage.md#choose-storage).

## Start and confirm recording {#start}

1. Select the video source in the meeting area.
2. Open its picture actions. On the main view, use the floating button; on a smaller tile, use the tile's action button.
3. Choose **Start recording** and wait for preparation to finish.
4. Confirm the status at the top of the conversation says **Recording** and elapsed time advances. Where space allows, the status also shows written size.

Only one recording can run at a time. While it is active, another source cannot start a second recording. Switching the main view does not switch the source being recorded: check the source name in the recording status.

## Pause, resume, and finish {#stop-and-save}

- Choose **Pause recording** in the source actions or top recording status to suspend capture. This keeps the recording open.
- Choose **Resume recording** to continue into the same file.
- Choose **Stop and save** to finish. Wait for **Saving recording** to complete and the **Recording saved** notification to appear.

**Success means:** the completed recording is available as a file and can be opened. A running timer or a paused status does not mean the file has been finalized.

Keep the app or page open until saving finishes. Closing the source menu or file panel does not stop recording. The source ending, being replaced, or leaving the conversation ends and saves it; for a deliberate finish, use **Stop and save** before leaving, refreshing, or closing the app.

## Find, preview, and export the file {#find-file}

1. Use the open action in **Recording saved**, or open the file library for the recording's storage location.
2. Find the file by its source name and timestamp. Confirm it has finished saving before opening it.
3. Preview or open it with a player that supports the file's video and audio codecs.
4. To keep a copy elsewhere, use the action that matches your storage:

| File location     | Action                                                                      |
| ----------------- | --------------------------------------------------------------------------- |
| Browser storage   | **Save to device** exports a copy through the browser                       |
| Local directory   | **Save as** creates a copy at another location                              |
| Windows directory | **Open file location** reveals the existing file in the system file manager |

If you changed the default storage after starting the recording, switch the library back to its original location. The file has not moved to the new default directory. To send the recording to someone else, use [file transfer or sharing](files.md).

## Choose MP4, MKV, or Auto {#formats}

The choice in **Settings → Audio & video → Recording** applies to the next recording.

| Choice | When to use it                                                                       |
| ------ | ------------------------------------------------------------------------------------ |
| Auto   | Start here to let Weblink choose a container that preserves the original codecs      |
| MP4    | Use when your target player accepts MP4 and supports the source's video/audio codecs |
| MKV    | Use when your player supports Matroska and the codecs you need to preserve           |

When reusing original codecs, Automatic generally selects MP4 for H.264/H.265 and MKV for other supported video codecs. G.722, PCMU, or PCMA audio selects MKV in Automatic mode. Available recording paths depend on the source and runtime; check the completed file's extension.

**The container is not the codec.** An MP4 can contain H.265. Selecting MP4 does not guarantee H.264 video, and renaming a file does not convert it. A manually selected container may require audio re-encoding.

For broader playback compatibility, use an available H.264 source and test a short recording in the intended player. Live playback and saved-file playback can use different decoder paths, so successful viewing alone does not prove that player can open the recording.

## Choose your next step {#next-steps}

- **Change where future recordings are written:** configure [file storage](storage.md#choose-storage).
- **The completed file will not play:** use the [recording playback FAQ](faq.md#recording-playback).
- **Recording fails while saving:** follow the [storage and saving checks](faq.md#storage-full).
- **Understand how received media becomes a file:** read [media transport and recording](../architecture/media.md).
