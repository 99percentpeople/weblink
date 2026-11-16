---
description: Record a video source, finish saving, and find or export the file.
outline: 2
---

# Recording and saving

Record **one video source and its associated audio** on the device that starts recording. This does not automatically combine every participant or save copies on other devices.

### Before recording {#prepare}

Open a local or received video source and confirm its picture and sound. Check **Settings → Transfers → File storage**; keep **Auto** under **Settings → Audio & video → Recording** for your first recording.

## Start recording {#start}

1. Select the source and open its picture actions, using the floating button on the main view.
2. Choose **Start recording** and wait for preparation.
3. Check the source name and advancing timer in the top recording status.

Only one recording runs at a time. Switching the main view does not change the source being recorded.

## Pause or finish {#stop-and-save}

Use **Pause recording** and **Resume recording** to continue in the same file. To finish, choose **Stop and save** and wait for **Recording saved**.

**Keep the app or page open until saving finishes.** Pausing does not finalize the file. Stop and save before refreshing, closing, or deliberately leaving the room.

## Find and export the file {#find-file}

Open it from the **Recording saved** notification, or find its source name and timestamp in **Account menu → File Cache**.

- For browser storage, **Save to device** exports a copy.
- For a local directory, **Save as…** creates a copy elsewhere; on Windows, **Open file location** reveals the original.

Open the completed file with your intended player to check the result.

::: details The source ends, or the storage location changes

Ending or replacing the source, or leaving the conversation, ends and saves the recording. Closing its menu or file panel does not stop it.

The recording keeps the storage location chosen at its start. Changing the default does not move it; select the original location in the library to find it. See [file storage](storage.md#change-directory).
:::

::: details Choose MP4 or MKV and check playback compatibility

### Recording formats {#formats}

Choose **Auto**, **MP4**, or **MKV** in **Settings → Audio & video → Recording**. The selection applies to the next recording.

Auto chooses a container that preserves the codecs. When reusing original codecs, H.264/H.265 generally use MP4 and other supported video codecs use MKV; G.722, PCMU, or PCMA audio selects MKV. Actual paths depend on the source and runtime, so check the file extension.

**MP4 is a container, not a guarantee of H.264 video.** It may contain H.265; renaming the extension does not convert it. A manually chosen container may require audio re-encoding.

For broader compatibility, use an available H.264 source and test a short recording in the target player. Live viewing and saved-file playback can use different decoders. The underlying process is explained in [media transport and recording](../architecture/media.md).
:::

## Choose your next step {#next-steps}

- **Change the destination for future recordings:** configure [file storage](storage.md#choose-storage).
- **The file will not play, or saving fails:** follow the [playback](faq.md#recording-playback) or [storage](faq.md#storage-full) checks.
