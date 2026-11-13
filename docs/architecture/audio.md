# Audio capture, codecs, and playback

Audio has its own capture, codec, transport, and playback path. It does not pass through the video's GPU encoder or presenter. Weblink uses browser-managed audio in the Web client, and native libwebrtc plus PCM bridges in the Windows native paths. Desktop sources can still use a browser publication, so the active media path matters more than the application window.

## Follow the sound through each stage {#stages}

| Stage                   | Data and responsibility                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| Capture                 | Obtain microphone or shared-system samples; the rate and channel count describe PCM     |
| Processing and encoding | Apply supported input processing, adapt samples, and encode the negotiated audio format |
| Transport               | Carry encoded audio in RTP/SRTP, alongside video and separate from signaling            |
| Receive and decode      | Buffer incoming packets, handle loss, and reconstruct samples                           |
| Playback                | Schedule samples, apply local listening controls, and send sound to an output device    |

PCM is a representation of samples in memory. Opus, G.722, PCMU, and PCMA are negotiated network formats. A PCM bridge is not an additional audio codec, and a playback device is not a decoder.

## Browser audio path {#browser}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="Browser microphone and screen-audio capture, encoding, decoding, and playback" tabindex="0">

![Microphone capture can apply browser-supported voice processing. Screen audio is a separate optional track. Each source enters the browser's WebRTC encoder and RTP transport. Received packets pass through buffering and decoding, then the shared audio element plays the received stream through the selected output.](/diagrams/browser-audio-en.svg)

</div>
<figcaption>The sending branches are separate sources, not an instruction to mix microphone and system audio. Blue arrows represent uncompressed audio flow; gray arrows represent encoded transport.</figcaption>
</figure>

### Capture and input processing {#browser-capture}

Microphone audio comes from `getUserMedia()` after device permission. Weblink requests echo cancellation, noise suppression, automatic gain control, and voice isolation when those constraints are reported as available. Their actual behavior remains browser/device dependent. Screen audio comes from `getDisplayMedia()` and is separate from the microphone.

Weblink requests screen audio and includes the system-audio hint, but the selected surface, operating system, browser, and user's choice determine whether an audio track is returned. A screen video track alone does not establish sound capture. This distinction is documented for [getDisplayMedia()](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia).

Capture sampling preferences use `ideal` constraints, so a device can return a different supported rate or channel count. By default, screen-audio constraints disable speech-oriented echo cancellation, noise suppression, and automatic gain control; microphone and shared-media processing are not interchangeable.

### Encoding and decoding {#browser-codecs}

The browser's RTP sender encodes the capture track into a format negotiated with the receiver. Weblink supplies format preferences; the browser owns its encoder, packetization, and transport. The ordinary Web call does not require Weblink to copy every PCM block through JavaScript or encode Opus in an AudioWorklet.

On reception, the browser handles RTP/SRTP, packet timing, jitter buffering, loss concealment, and audio decoding. Available recovery features depend on the negotiated codec and implementation; a missing packet cannot always be reconstructed. The resulting audio track supplies samples to playback.

### Playback {#browser-playback}

Weblink's shared audio player binds received tracks through `audio.srcObject`. Source mute, listening state, and output-device selection are separate from the sender's capture state. The normal browser path feeds this player directly, without the application's native PCM bridge.

Output selection uses `HTMLMediaElement.setSinkId()` when supported. Without it, the application can use the default output but cannot promise selection of another device. Device permission and browser policy still apply; see the [output-device API](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId).

## Windows native audio paths {#native}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="Native system capture, WebView microphone bridge, native decoding, and Web Audio playback" tabindex="0">

![WASAPI system loopback feeds PCM directly to native encoding. A microphone attached to the native room instead uses WebView capture and a PCM AudioWorklet bridge. Native reception decodes audio into bounded PCM, crosses IPC, and uses a playback worklet and MediaStream destination to feed the same audio player and output-device controls.](/diagrams/native-audio-en.svg)

</div>
<figcaption>System capture and microphone capture enter differently. Native decoding ends before the playback worklet: that worklet consumes PCM, not Opus or another compressed bitstream.</figcaption>
</figure>

### System audio: WASAPI to native encoding {#native-system-audio}

When native screen sharing includes sound, a Windows WASAPI worker captures process-loopback audio. Weblink excludes its own process tree, including its WebView children, to avoid sending the meeting's playback back into the meeting. This is system sound outside that tree, **not audio isolated to the selected capture window**. Microsoft's [process-loopback example](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/) explains this include/exclude mechanism.

The worker obtains signed 16-bit PCM at the configured, supported sample rate and channel count. It supplies timestamped 10 ms blocks to a native audio source; libwebrtc then encodes and transports them. Normal system-audio sending keeps those PCM blocks native. An optional recording consumer can request its own data path.

Native system-audio format discovery is separate from microphone discovery. A microphone accepting a rate does not prove that the loopback source accepts the same configuration.

### Microphone: WebView capture to the native room {#native-microphone}

A microphone track attached to the Windows native room still starts with WebView capture and its permissions/input-processing constraints. Weblink creates a 48 kHz AudioContext, and a microphone AudioWorklet converts floating-point samples to interleaved stereo signed 16-bit PCM. Bounded batches cross IPC into the native audio source, which supplies 10 ms frames to libwebrtc.

The bridge allows one captured source to feed several peers without repeating capture and PCM IPC for every viewer. It writes no microphone samples to the local speaker output. Its worklet is a PCM adapter, not an Opus encoder.

This describes the native room attachment. A microphone accompanying the browser camera-publication path uses that browser RTP sender instead. “Desktop microphone” therefore does not imply that all capture and encoding happen outside WebView.

### Native decoding to Web Audio playback {#native-playback}

The native receiver performs WebRTC reception and audio decoding. Its output adapter requests **48 kHz, two-channel, signed 16-bit PCM**, regardless of whether the network format is Opus, G.722, PCMU, or PCMA. Adaptation to this playback format does not restore detail absent from the source.

Decoded blocks enter a bounded native queue. Notifications cause the frontend to read PCM over IPC and transfer it to the receive AudioWorklet. The worklet converts samples to floating point, feeds a Web Audio `MediaStreamDestination`, and exposes its audio track to Weblink's shared HTML audio player.

There is no second Opus decode or network re-encoding in this bridge. The same player handles local source mute and supported output-device selection. Native decoding does not bypass WebView playback policy: both the AudioContext and the media element must be allowed to run.

Queues are bounded on both sides. After a stall, stale buffered audio can be discarded to return toward live playback instead of replaying an ever-growing history. Missing output samples produce silence; buffering cannot manufacture missing speech.

## Browser and native paths compared {#comparison}

| Responsibility                 | Browser path                                         | Windows native path                                                         |
| ------------------------------ | ---------------------------------------------------- | --------------------------------------------------------------------------- |
| Microphone capture             | Browser capture and supported processing constraints | WebView capture; PCM bridge when attached to the native room                |
| Shared system sound            | Optional audio track supplied by the screen picker   | WASAPI process loopback, excluding Weblink's process tree                   |
| Encoding and network transport | Browser WebRTC implementation                        | Native libwebrtc for native publications/room tracks                        |
| Received samples               | Browser decoder feeds its audio track                | Native decoder/output adapter → bounded PCM → IPC → AudioWorklet            |
| Playback controls              | Shared HTML audio player and supported output API    | PCM destination track enters the same player and output API                 |
| Resource ownership             | Browser manages the live media path                  | Weblink also owns capture workers, PCM bridge queues, and worklet lifetimes |

Weblink has no audio counterpart to its NVENC/D3D11 video pipeline. Native audio codecs and the explicit PCM adapters run as software; the browser/OS may apply its own audio processing or device DSP. An [AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet) executes on a Web Audio processing thread, not the GPU or the page's ordinary UI thread. Video hardware acceleration does not prove audio acceleration, and choosing native audio does not imply lower latency in every environment.

## Audio formats and clocks {#formats}

Weblink's current automatic preference order is **Opus → G.722 → PCMU → PCMA**, filtered by the active sender and receiver capabilities. Opus and G.711 PCMU/PCMA are WebRTC baseline codecs under [RFC 7874](https://www.rfc-editor.org/rfc/rfc7874.html#section-3). Manual choice still requires compatible negotiation.

| Format      | RTP timestamp clock | Audio detail relevant to this path                                                      |
| ----------- | ------------------- | --------------------------------------------------------------------------------------- |
| Opus        | 48 kHz              | Supports voice and general audio; bandwidth and mono/stereo use depend on configuration |
| G.722       | 8 kHz               | Decoded audio is 16 kHz; Weblink's supported recording mapping is mono                  |
| PCMU / PCMA | 8 kHz               | G.711 μ-law / A-law narrowband audio; Weblink's mapping is mono at 8 kHz                |

An RTP clock is not necessarily the capture sample rate. Opus uses a 48 kHz timestamp clock across its modes ([RFC 7587](https://www.rfc-editor.org/rfc/rfc7587.html#section-4.1)); G.722 retains an 8 kHz RTP clock despite 16 kHz audio ([RFC 3551](https://www.rfc-editor.org/rfc/rfc3551.html#section-4.5.2)). A native 48 kHz stereo playback bridge does not prove full-band stereo was captured or transmitted.

## Sampling, processing, and latency {#sampling-and-latency}

| Setting or stage                 | What it changes                                                                                       |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Capture sample rate and channels | Samples available before encoding; supported formats can differ between microphone and system capture |
| Echo cancellation                | Attempts to remove speaker sound picked up by the microphone                                          |
| Noise suppression / gain control | Adjusts background noise or signal level; these can alter music and other non-speech material         |
| Codec and encoded bitrate        | Network representation and data budget, separate from the PCM capture format                          |
| Buffering and playback           | Trades resilience to timing variation against additional delay                                        |

The default sampling preference is 48 kHz and two channels, not an end-to-end fidelity guarantee. Increasing the requested capture rate does not change the codec's RTP clock or guarantee additional transmitted detail. Copying a mono signal into two PCM channels does not create a stereo recording.

Total delay includes capture blocks, processing, codec packetization, network transit, receive buffering, any PCM bridge, and device output. A native 10 ms input block is not a promise of a 10 ms RTP packet or 10 ms end-to-end latency. Audio and video also have separate queues, so smooth video alone does not establish timely sound.

## Capture mute, listening mute, and local suppression {#playback-controls}

| Control                                            | Boundary                                                                                                  |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Sender microphone/system-audio mute                | Controls that outgoing source; native loopback can deliver silent samples while retaining its live source |
| Receiver source/member mute                        | Disables local listening tracks; it does not turn off the remote microphone                               |
| Global listening control                           | Pauses or resumes the shared player without ending the sender's capture                                   |
| Suppress local playback while sharing system audio | Changes playback on the capturing machine while capture can continue                                      |

The last option differs by platform. The browser receives the supported `suppressLocalAudioPlayback` constraint for display capture only. In the native path, Weblink temporarily mutes the active Windows playback endpoints while process-loopback capture continues. This can silence other local applications and local meeting playback too; it is not a per-window volume control. Capture cleanup restores endpoints that Weblink muted, while preserving a pre-existing mute or a manual unmute.

Both browser audio and native audio returned through Web Audio remain subject to [autoplay rules](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay). User interaction can be needed to start listening even when media is already arriving. Operational checks for missing sound belong in the [audio FAQ](../guide/faq.md#no-audio).

## Implementation entry points {#implementation}

Paths are relative to the repository root:

| Path                                                      | Responsibility                                            |
| --------------------------------------------------------- | --------------------------------------------------------- |
| `apps/web/src/libs/application/meeting-audio-settings.ts` | Capture sampling preferences and display-only suppression |
| `apps/web/src/libs/state/create-audio-player.ts`          | Received tracks, listening controls, and output selection |
| `crates/desktop-capture/src/media/windows/audio.rs`       | Native loopback PCM capture and source delivery           |
| `apps/desktop/src/room/capture.ts`                        | Microphone PCM bridge into the native room                |
| `crates/desktop-capture/src/room_peer/source.rs`          | Native audio source and PCM frame validation              |
| `crates/desktop-capture/src/receive/output.rs`            | Native decoded-audio output and bounded queue             |
| `apps/desktop/src/room/output.ts`                         | Native room PCM delivery to Web Audio                     |
| `apps/desktop/src/receive-audio.worklet.js`               | Bounded PCM playback adapter                              |

## Choose your next step {#next-steps}

- **Choose capture devices, sound settings, or recording options:** follow the [audio and video guide](../guide/media.md).
- **Compare the video codecs and GPU presentation paths:** read [encoding, decoding, and GPU presentation](codecs.md).
- **Understand how audio packets enter a saved file:** continue with [media transport and recording](media.md#recording).
- **Picture works but sound is missing:** use the [audio troubleshooting steps](../guide/faq.md#no-audio).
