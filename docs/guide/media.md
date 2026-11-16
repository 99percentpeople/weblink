---
description: Start a voice or video call, share a screen with sound, check what others receive, and stop sharing.
---

# Screen sharing and calls

Use the meeting controls to talk, turn on a camera, or show a screen to other room members. To save a video source as a file, use the separate [recording and saving guide](recording.md).

## Before your first call or screen share {#before-you-start}

1. [Connect the devices](../index.md#connect-two-devices) and confirm a chat message reaches the other side.
2. Open the meeting controls at the bottom of the conversation. If the controls are collapsed, expand them.
3. Have the microphone, camera, or screen you want to use ready. Browsers generally require HTTPS or localhost and browser/system permission. Opening a LAN HTTP page alone does not make capture available.
4. If two devices are in the same physical room, use headphones or mute one playback device to avoid feedback.

Microphone audio and captured system audio are separate sources. Muting the microphone does not necessarily mute sound shared with a screen.

## Make a voice or video call {#camera-and-microphone}

1. **On the speaker's device**, choose **Enable microphone** in the bottom controls. Grant microphone permission when prompted.
2. To send video as well, choose **Turn camera on** and grant camera permission.
3. Use **Audio devices** or **Camera devices** beside the corresponding control to choose a device. More preferences are in **Settings → Audio & video**.
4. Check the local camera preview. **On the other device**, confirm that the speaker is audible and the camera picture is visible; check playback volume and that the member is not muted.
5. For a two-way call, repeat the microphone/camera steps on the other device.

**Success means:** the other device receives your voice or camera picture. A local preview only confirms local capture. You can leave the camera off for a voice-only conversation.

Use **Mute microphone** or **Turn camera off** to stop that source while remaining in the room.

## Share a screen with optional system sound {#screen-sharing}

1. **On the sharing device**, choose **Share screen** in the bottom controls.
2. In the capture picker, select the screen, window, or browser tab offered by your client. Confirm the selected source before starting.
3. If you want to send system or tab sound, enable the audio option when the picker offers it. Audio availability depends on the operating system, browser, and source type.
4. **On the receiving device**, select the shared source in the meeting area to open it as the main view. Ask the recipient to confirm both the picture and any sound you intended to send.
5. While already sharing, use **Add screen** if you want another source and the client offers that action.

The Windows desktop picker distinguishes monitors from windows. A window is suitable for showing one application. To let someone operate the computer, share a monitor and follow [remote desktop authorization](remote-control.md#connect); viewing permission alone does not allow input.

**Success means:** the receiver sees changes as you move something in the selected source. If you included sound, play a short sample and have the receiver confirm it. Opening a video menu or seeing your own preview is not this check.

A phone can receive shared screens and act as a remote controller. Screen capture on the phone itself depends on the browser and platform; do not assume it has the desktop capture picker.

## Adjust picture and sound {#quality}

Open **Settings → Audio & video**. Keep automatic codec and encoder selection for the first connection, then change one setting at a time.

| Your priority                       | What to adjust                                                                                                   |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Read text and desktop details       | Start with a legible resolution, then balance frame rate and bitrate                                             |
| Show movement smoothly              | Increase frame rate only as far as the available bandwidth and processing capacity allow                         |
| Reduce bandwidth or processing load | Lower resolution or frame rate; a higher bitrate limit does not add network capacity                             |
| Choose a specific desktop encoder   | Select a detected encoder/format pair supported by the receiving device, then restart sharing                    |
| Hear the intended sound             | Check microphone mute, capture-audio selection, the receiving member/source mute, and playback volume separately |

Resolution, frame rate, and bitrate are targets or limits, not guaranteed results. They can affect active streams. Changing the encoder, codec, or capture backend requires starting sharing again to use the new selection.

Automatic encoding chooses formats the sender can encode and the receiver can decode; native screen and camera publication choose per receiver. A manual choice still needs a compatible receiver. Hardware encoding, native decoding, and GPU presentation are separate stages, so choosing an encoder alone does not determine the whole path.

Where supported by the source, the viewer can request lower received resolution, FPS, or bitrate within the publisher's limits. Detailed browser/native behavior is covered in [encoding, decoding, and GPU display](../architecture/codecs.md).

## Stop sharing or leave the call {#stop-sharing}

- **Stop your microphone or camera:** use its control in the bottom bar.
- **Stop a shared picture:** use that local source's close action. **Stop sharing** in the meeting controls ends screen sharing.
- **Leave the conversation:** leave the room to end your live connections.

Check that the source disappears on the receiver. Closing the source menu, hiding the main window, or switching panels does not stop an active share. Microphone, camera, and screen sharing are separate: check each source you enabled before you finish.

## Record a source you are watching {#recording}

Choose **Start recording** in the video source's picture actions. One local or received video source and its associated audio can be recorded at a time; recording does not automatically include every participant.

For preparation, pause/resume, **Stop and save**, and finding the completed file, follow [recording and saving](recording.md). Its [format guide](recording.md#formats) explains MP4, MKV, and playback compatibility.

## Choose your next step {#troubleshooting}

- **Operate the computer whose screen you can see:** set up [remote desktop](remote-control.md).
- **Understand hardware acceleration and CPU fallback:** compare the [video](../architecture/codecs.md#comparison) and [audio](../architecture/audio.md#comparison) paths.
- **The browser cannot capture, sound is missing, or video is black:** use the [capture](faq.md#capture), [audio](faq.md#no-audio), or [video](faq.md#video) FAQ.
