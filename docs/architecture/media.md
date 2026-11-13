# Media transport and recording

Weblink separates media capture, connection negotiation, decoding, presentation, and recording. A successful connection only establishes part of this pipeline. Browser clients and the Windows desktop client share application workflows but can use different media implementations.

## From a source to a displayed frame {#pipeline}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="Media delivery and recording data flow" tabindex="0">

![Capture feeds encoding and WebRTC, then the receiver decodes and presents media. Depending on the source, recording uses MediaRecorder or an encoded-packet muxer; both write through bounded VFS storage and finalize the file on stop.](/diagrams/media-en.svg)

</div>
<figcaption>The top row follows live media delivery. The lower branches are alternative recording engines selected for the actual source; muxing encoded packets preserves their codecs.</figcaption>
</figure>

| Stage     | Work performed                                       | Relevant limit                                           |
| --------- | ---------------------------------------------------- | -------------------------------------------------------- |
| Capture   | Obtain camera, microphone, screen, or window content | OS/browser permission and source availability            |
| Encode    | Turn captured content into a negotiated codec        | Available encoders, resolution, frame rate, and bitrate  |
| Transport | Carry encoded media over WebRTC RTP                  | A direct or TURN path, bandwidth, loss, and congestion   |
| Decode    | Reconstruct frames or audio samples                  | The receiver's actual WebRTC codec support               |
| Present   | Display video and play audio                         | Rendering resources, output devices, and playback policy |

Control messages identify sources and coordinate publication. Media bytes travel on the media path rather than inside chat JSON. Browser tracks are associated with negotiated media sections; native sources also have platform-owned source identifiers. A UI tile is a view of a source, not the owner of its capture or connection.

Room camera, microphone, and screen publications can have independent lifetimes. Sharing with several participants uses the sender's outgoing resources; the signaling backend does not mix the streams or transcode them for weaker receivers.

## Codec negotiation follows the actual path {#codecs}

Sending and receiving capabilities are separate. A browser can expose an encoder without the same receive support, and a file player can support a format that the browser's WebRTC receiver does not advertise. The desktop native implementation has its own capabilities, independent of its WebView's browser media APIs.

Automatic codec selection considers the sender's encoders and the target receiver's decoders. Native screen and camera publication choose per receiver, so viewers can use different compatible formats. A manual codec preference cannot create a decoder that is absent on the receiver. The selection order and hardware preference are explained in [encoding, decoding, and GPU presentation](codecs.md#negotiation).

This is particularly relevant to H.265/HEVC. Browser version, platform, and enabled capabilities affect the result; the current verified browser cases and their scope are kept in the [H.265 compatibility FAQ](../guide/faq.md#hevc-browsers). Changing the signaling server or adding TURN does not transcode H.265 into another codec.

Weblink checks more than whether `setRemoteDescription()` succeeded. For a screen receive session, an answer that rejects the video section or negotiates a direction that cannot receive video is treated as an unsupported receive path. Such negotiation can return a valid answer without the browser throwing an exception.

After negotiation, receiving packets is still different from decoding frames. Decode-progress monitoring can identify a stalled video path even when network traffic exists. Codec selection, SDP acceptance, and actual decoded-frame progress are three distinct pieces of evidence.

## Browser and native desktop implementations {#platforms}

The browser implementation uses browser capture, WebRTC, and rendering APIs. Its codec may use hardware or the CPU independently of GPU composition; see the [browser media path](codecs.md#browser-path) and [acceleration conditions](codecs.md#browser-acceleration). The Windows desktop implementation has both native sending and native receiving paths supplied by the platform adapter, while retaining the shared frontend and application services.

Audio uses its own capture, codec, and playback path. Windows system sound can enter native WebRTC through WASAPI, while decoded native audio returns through a bounded PCM/Web Audio bridge to the shared player. For microphone routing and the browser/native comparison, see [audio capture, codecs, and playback](audio.md).

Hardware encoding can consume D3D11 textures, and hardware decoding can return them to the shared GPU presenter. Native software decoding uploads its output into the same presenter. For the complete data flow and conditional CPU readback, see the [native encoding and decoding paths](codecs.md#native-encode).

Native video presentation uses GPU resources, including D3D11 textures and DirectComposition. A bounded latest-frame queue keeps old frames from accumulating when presentation falls behind. Frame ownership extends until the GPU has finished using a resource, so a frame cannot be recycled merely because the JavaScript callback returned.

The native presentation surface and the HTML controls are separate. Source identity, visibility, and teardown must be coordinated across them; a placeholder DOM video element is not itself a recording source. These details allow native media to use the actual capture or receive path without forcing every frame through a browser canvas.

Remote input is a separate authorized operation. Displaying a shared monitor does not grant control, and a valid input grant is bound to the device and source that issued it. Revocation or session teardown stops the corresponding input activity. The [device identity article](device-trust.md) explains that authorization boundary.

## Recording: encoded content and containers {#recording}

A recording follows one selected video source and its associated audio. It is not an automatic composite of the entire conference. The recording service chooses an engine for the actual source and platform, then writes the result through the common storage service.

Where encoded packets are available, the recorder can mux them into a container while preserving their codecs. Muxing organizes existing encoded data; it does not make an unsupported codec playable by converting it. Browser `MediaRecorder` paths choose a supported MIME type and can use the browser's own encoding pipeline.

For the encoded-packet path, automatic container selection currently follows these rules:

| Available encoded tracks                                    | Automatic container                           |
| ----------------------------------------------------------- | --------------------------------------------- |
| G.722 or G.711 audio (`g722`, `ulaw`, `alaw`)               | Matroska (`.mkv`) to preserve the audio codec |
| H.264/AVC or H.265/HEVC video, without the audio case above | MP4 (`.mp4`)                                  |
| Other supported video codecs                                | Matroska (`.mkv`)                             |

The browser recorder may instead produce WebM or another supported MIME type. The saved extension follows the actual output format. Choosing MP4 does not imply that all input codecs can be copied into it, and renaming an extension does not change the container or codec.

Native sources supply real encoded media or an explicit pixel readback to the recording engine, according to the available source path. A UI lifecycle track is not the recorded picture. The distinction between local encoded sources and received native surfaces is explained in [GPU presentation and recording](codecs.md#gpu-presentation). Recording ownership remains separate from whether its settings panel is visible.

## Stopping and saving {#recording-lifecycle}

Pause keeps the recording engine and output file while excluding the paused interval from the recording timeline. Stop starts finalization: wait for the last media data, drain pending writes, finish container metadata, and publish the completed file.

The writer uses bounded buffering so a slow destination does not grow an unlimited queue. Storage finalization is part of the operation; closing the panel is not a substitute for stopping the recorder. An application crash before finalization can leave a draft whose playability is not guaranteed.

The selected destination affects new recordings. Existing recording writers keep their original mount when the default storage changes. See [storage finalization](storage.md#finalization) for the distinction between receiving bytes and publishing a complete file.

## Implementation entry points {#implementation}

Paths are relative to the repository root:

| Path                                                          | Responsibility                                            |
| ------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/web/src/libs/domain/media-codecs.ts`                    | Codec descriptions and compatibility decisions            |
| `apps/web/src/libs/domain/native-screen/`                     | Screen session negotiation and decode monitoring          |
| `apps/web/src/libs/application/media-receive-service.ts`      | Application receive lifecycle                             |
| `apps/web/src/libs/application/recording-service.ts`          | Recording ownership and orchestration                     |
| `apps/web/src/libs/application/recording-engine.ts`           | Common recording lifecycle and browser recorder selection |
| `apps/web/src/libs/application/recording-options.ts`          | Recording container and output format selection           |
| `packages/platform`, `apps/desktop`, `crates/desktop-capture` | Platform contracts and native integration                 |

## Choose your next step {#next-steps}

- **Follow pixels through browser and native codecs and GPU display:** continue with the [codec and presentation article](codecs.md).
- **Follow sound through capture, audio codecs, and device output:** read the [audio path article](audio.md).
- **Adjust quality, share a source, or start recording:** follow the [audio and video guide](../guide/media.md).
- **Investigate black video, H.265 rejection, or an unplayable recording:** use the [media FAQ](../guide/faq.md#media).
- **Understand the permissions behind screen control:** continue with [device identity and authorization](device-trust.md).
