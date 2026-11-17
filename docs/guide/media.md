---
description: Make a call, share a screen with sound, and stop the sources you enabled.
outline: 2
---

# Screen sharing and calls

### Before you start {#before-you-start}

[Join the same room](rooms.md#join), then use the meeting controls at the bottom. Browsers need capture permissions and usually HTTPS or localhost. Use headphones if nearby devices would cause feedback.

## Make a voice or video call {#camera-and-microphone}

1. Choose **Enable microphone**, and **Turn camera on** if you want video. Grant permissions when prompted.
2. Ask the other person to confirm they can hear and see you. For a two-way call, they enable their microphone or camera too.

Choose devices through **Audio devices** or **Camera devices** beside the controls. Use **Mute microphone** or **Turn camera off** to stop that source.

## Share a screen and sound {#screen-sharing}

1. Choose **Share screen**, select the screen, window, or tab offered by your client, and confirm.
2. Include audio if you want system or tab sound and the picker offers it.
3. Have the receiver select the shared source and confirm the picture and sound.

**Microphone audio and shared system audio are separate.** Muting the microphone may leave screen-share audio active. System audio and phone screen capture depend on the platform, browser, and selected source.

Windows desktop can share a monitor or window. To let someone operate the computer, share a monitor and complete [remote-control approval](remote-control.md#connect).

::: details Add another view or tune picture quality

Use **Add screen** while sharing if the client offers it.

### Picture and sound settings {#quality}

Open **Settings → Audio & video**. Start with automatic codec and encoder selection; change one setting at a time.

- For text, prioritize a readable resolution.
- For movement, balance frame rate against bandwidth and device performance.
- To reduce load, lower resolution or frame rate. Increasing a bitrate limit does not add network capacity.
- Codec, encoder, or capture-backend changes need sharing to restart. Resolution, frame rate, and bitrate can affect active streams, but remain targets or limits.

Automatic selection considers sender and receiver support; native publication selects per receiver. A viewer may request lower quality within the publisher's limits. Hardware encoding, decoding, and GPU display are separate stages; see the [video](../architecture/codecs.md#comparison) and [audio](../architecture/audio.md#comparison) comparisons.
:::

## View performance statistics {#statistics}

To inspect stutter or delay, enable **Stream statistics** in the main picture's actions. Move the floating window, expand receiver details, or copy diagnostics. Reception prioritizes end-to-end latency, FPS, and bitrate; local preview shows the slowest receiver's sender-processing estimate, local FPS, and total bitrate. See [video statistics and latency](../architecture/statistics.md) for definitions and the measurement diagram.

## Stop sharing or leave {#stop-sharing}

Use the microphone and camera controls to stop those sources. Close an individual shared picture through its source actions, or use **Stop sharing** in the bottom controls. Leave the room to end your live connections.

**Closing a menu, hiding the window, or switching panels does not stop sharing.** Check each source you enabled; microphone, camera, and screen sharing are controlled separately.

### Save a recording {#recording}

Choose **Start recording** in a video source's picture actions. Follow [recording and saving](recording.md) to finish and find the file.

## Choose your next step {#troubleshooting}

- **Operate the computer whose screen you see:** set up [remote desktop](remote-control.md).
- **Capture is unavailable, sound is missing, or video is black:** use the [capture](faq.md#capture), [audio](faq.md#no-audio), or [video](faq.md#video) FAQ.
