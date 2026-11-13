# Audio, video, and recording

After joining a room and connecting devices, enable your microphone, camera, or screen sharing. Browsers use the system capture picker; Windows desktop also provides native monitor and window sharing.

## Enable voice and camera {#camera-and-microphone}

1. Enable the microphone or camera using the conversation's media controls.
2. Grant browser and operating-system permissions when prompted.
3. Choose devices and preferences in **Settings → Audio and video**.
4. Check the local preview and mute state, then ask the other device to confirm sound and video.

Browsers generally require HTTPS or localhost. Being able to open a LAN HTTP page does not mean camera, microphone, or screen capture is available.

## Share a monitor or window {#screen-sharing}

Use screen sharing to select a source and confirm capture. System audio availability depends on the platform, browser, and source type.

The Windows desktop picker distinguishes monitors from windows. Window sharing is for viewing. To let another device control the computer, select a monitor and authorize it through [Remote desktop](remote-control.md).

Stop sharing through the sharing status or the source's stop action. Hiding the main window or closing a source menu does not end existing sharing.

## Adjust picture and sound {#quality}

In **Settings → Audio and video**, adjust resolution, frame rate, and bitrate. Higher settings need more bandwidth and device performance; these are targets or limits, not guaranteed results.

Automatic encoding chooses among formats the sender can encode and the target device can decode. Native screen and camera publication choose per receiver. A manual choice still needs a compatible receiver.

Available desktop capture methods and encoders depend on the system and hardware. Resolution, frame rate, and bitrate can affect active streams. Encoder, codec, or capture-backend changes require starting sharing again to use the new choice. Use automatic options when unsure.

For audio, check the source's mute state and the viewer's playback volume. To share system sound, select an audio-capable capture source and include audio in the capture picker when offered.

For deliberate quality adjustments:

1. Start with automatic codec/encoder selection, and confirm that the target device receives a picture.
2. For text and detailed desktop work, prioritize legible resolution. For motion, balance frame rate against the available bitrate and processing capacity.
3. Change one parameter at a time. Raising the bitrate limit cannot increase the link's capacity; reduce frame rate or resolution when the current budget cannot sustain them.
4. On desktop, choose a detected encoder/format pair when you need explicit control. Hardware encoding, native decoding, and GPU presentation are separate stages.
5. A viewer can request lower received resolution, FPS, or bitrate where the source supports these controls; the request stays within the publisher's limits.

The [encoding, decoding, and GPU display article](../architecture/codecs.md) explains these tradeoffs and compares browser and native paths, including hardware acceleration and CPU fallback. Browser-specific failures remain in the FAQ.

## Record one video source {#recording}

1. Start recording from the menu of the video source you want to capture.
2. Watch recording status, elapsed time, and written size at the top of the conversation.
3. Pause when needed; resuming continues in the same file.
4. Stop and wait for saving to finish, then preview or save a copy from the file library.

One local or received video source and its associated audio can be recorded at a time. Recording does not automatically include every participant in the meeting.

Choose Automatic, MKV, or MP4 in **Settings → Audio and video → Recording**. When reusing the original media codecs, Automatic generally saves H.264/H.265 as MP4 and other supported video codecs as MKV; G.722, PCMU, or PCMA audio uses MKV. Available formats depend on the source and runtime, so check the completed file's extension. External players must also support the codecs inside the file.

Recording uses the [storage location](storage.md) selected when it starts. Changing the default directory does not move it. Closing its menu or file panel does not stop it; the source ending or being replaced, or leaving the conversation, ends and saves it.

## Choose your next step {#troubleshooting}

- **Operate the remote computer while viewing its screen:** set up [remote desktop](remote-control.md).
- **Choose where recordings are saved:** configure the [storage location](storage.md#choose-storage).
- **Compare browser and native codecs, GPU acceleration, and CPU fallback:** read [encoding, decoding, and GPU presentation](../architecture/codecs.md#comparison).
- **Understand microphone capture, system sound, and native PCM playback:** read the [audio path comparison](../architecture/audio.md#comparison).
- **Follow live media into a recording container:** read about [media transport and recording](../architecture/media.md).
- **Check H.265 support or fix black video and unplayable recordings:** use the [codec and video FAQ](faq.md#media).
