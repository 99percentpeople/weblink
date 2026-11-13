# Encoding, decoding, and GPU presentation

Weblink has browser media paths and native Windows sending and receiving paths. Capture, encoding, decoding, and presentation are separate stages, each with its own acceleration conditions. The browser manages its codec implementations and renderer; the Windows native backend can pass GPU textures between capture, supported hardware codecs, and the shared presenter.

## Codec, encoder, decoder, and presenter {#roles}

| Term      | Responsibility                                                  | Example                                                         |
| --------- | --------------------------------------------------------------- | --------------------------------------------------------------- |
| Codec     | Defines how media is represented in compressed form             | H.264/AVC, H.265/HEVC, VP8, VP9, AV1                            |
| Encoder   | Converts raw pictures into a compressed bitstream               | NVENC, a Media Foundation encoder, or a native software encoder |
| Decoder   | Reconstructs pictures from that bitstream                       | A Media Foundation decoder or a bundled native software decoder |
| Presenter | Displays decoded or captured pictures in the application window | D3D11 processing and DirectComposition in the Windows client    |
| Container | Organizes recorded tracks and timing in a file                  | MP4, MKV, or WebM                                               |

Choosing H.264 selects a format; it does not select one specific encoder implementation. Native code can run software decoding on the CPU. GPU presentation can display those software-decoded pictures after an upload. These are independent capabilities.

WebRTC carries compressed media over RTP. The other device reconstructs pixels; it does not receive the sender's GPU texture. A recording container is another layer, described in [media transport and recording](media.md#recording).

## What video encoding compresses {#compression}

Video encoders exploit similarity within a picture and between pictures. A keyframe provides a new decoding starting point; predicted pictures reuse reference information. Scene changes and detailed motion generally need more data than a static desktop. Lossy compression trades picture detail for a smaller bitstream. See the [MDN video codec guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs).

Keyframes help a new viewer or a recovering decoder start correctly, but they can also cause larger bursts. Weblink requests recovery keyframes when needed; lowering the bitrate does not turn every picture into an independent image. The exact reference structure and keyframe policy depend on the encoder.

Raw pixels and encoded bitrate have very different scales. At 1920 × 1080, four bytes per BGRA pixel, and 60 full frames per second, one raw copy represents about **498 MB/s**. This is a byte-count illustration, not a measured throughput or network requirement. Avoiding repeated raw GPU → CPU → GPU transfers is therefore distinct from reducing the compressed network bitrate.

## Browser capture, encoding, decoding, and display {#browser-path}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="Browser sending, receiving, and conditional software paths" tabindex="0">

![Browser capture produces tracks for local preview and WebRTC sending. The browser chooses hardware or CPU encoding. On reception, hardware or CPU decoding supplies the video track displayed by a video element. GPU composition and software rendering are separate presentation choices.](/diagrams/browser-media-en.svg)

</div>
<figcaption>This is a logical media flow, not a promise that every arrow carries a GPU texture. Dashed paths represent conditional software implementations, which can be selected at startup as well as after a hardware failure.</figcaption>
</figure>

### Sending: capture tracks to WebRTC {#browser-encode}

Weblink obtains camera and microphone tracks through `getUserMedia()`, and screen tracks through `getDisplayMedia()`. Video tracks enter `RTCPeerConnection` through an RTP sender. Weblink sets codec preferences and supported resolution, frame-rate, and bitrate limits; the browser performs frame adaptation, encoding, and RTP/SRTP transport.

`setCodecPreferences()` influences the format negotiated with the peer. It does not let Weblink select NVENC, a specific GPU, or a particular software encoder. The browser path does not pass native hardware rankings into Weblink's codec selection. See the [WebRTC codec preference definition](https://www.w3.org/TR/webrtc/#dom-rtcrtptransceiver-setcodecpreferences).

Local preview binds the capture stream to a video element directly. It does not encode a local copy and decode it again. Weblink's ordinary browser call path does not compress raw frames in JavaScript; even a CPU codec normally runs inside the browser's media implementation. Accessing encoded packets for [recording](media.md#recording) is a separate consumer of media that has already been encoded.

### Receiving: WebRTC decoding to the video element {#browser-decode}

The browser receives and decrypts media, manages its jitter buffer and loss recovery, then decodes the negotiated bitstream. Weblink binds the received `MediaStream` to `video.srcObject`. The track supplies decoded pictures for display; the video element does not require a second encode/decode round trip.

A hardware decoder can provide GPU-backed pictures. A software decoder produces CPU-accessible pictures that may be uploaded for GPU composition. The browser owns these resources, conversions, and copies; Weblink does not manage their D3D11 textures or promise a zero-copy path.

GPU composition is separate from hardware decoding. CPU-decoded video can still appear in a GPU-composited page, and the browser can use a software rendering path when accelerated composition is unavailable. Chromium's [compositing overview](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/) explains this rendering distinction; exact resource paths vary by browser and platform.

## When the browser uses hardware or CPU codecs {#browser-acceleration}

“GPU acceleration” here includes dedicated video engines on a GPU or SoC, not just its 3D rendering cores. Encoding, decoding, and composition are independent: hardware support for receiving a format does not prove hardware support for sending it.

| Condition                                                                                                                                    | Possible browser behavior                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| The negotiated format/profile and requested configuration fit an available hardware backend, with working drivers and acceleration permitted | The browser can select hardware encoding or decoding; CPU work for control and transport remains                  |
| Hardware support is absent, not exposed by that browser/build, or disabled by settings or driver policy                                      | Use a compatible software implementation if one is provided; otherwise the format or configuration is unavailable |
| Hardware initialization fails or the backend requests a software fallback                                                                    | The browser may switch implementations if a compatible software codec can initialize; recovery is not guaranteed  |
| The browser's selection policy prefers software for the workload or required features                                                        | CPU encoding may be selected from the start, even on a machine with a hardware encoder                            |

These are conditions to distinguish, not one mandatory fallback algorithm across browsers. For example, libwebrtc has [encoder fallback and selection logic](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/video_encoder_software_fallback_wrapper.cc) and a separate [decoder fallback wrapper](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/video_decoder_software_fallback_wrapper.cc). Available backends and driver restrictions also depend on the platform, as illustrated by Chromium's [video acceleration documentation](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/gpu/vaapi.md).

Software fallback requires support for the **same negotiated bitstream**. An unavailable H.265 decoder cannot silently decode that stream as H.264. Using another codec requires compatible negotiation or a restarted publication. A hardware resource failure may instead cause interruption; a slow CPU path may lower effective quality or frame rate. Neither case guarantees a seamless switch.

Weblink's browser call path has no force-GPU switch. WebCodecs exposes a separate `hardwareAcceleration` hint for its own encoder/decoder instances; that hint does not configure `RTCPeerConnection`. File playback, WebCodecs support, and WebRTC support must be evaluated separately. See the [WebCodecs hardware acceleration definition](https://www.w3.org/TR/webcodecs/#hardware-acceleration).

## Native sending: GPU capture to encoded media {#native-encode}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="Native capture, GPU encoding, and fallback paths" tabindex="0">

![Native capture supplies a D3D11 texture. GPU preparation feeds NVENC or a compatible Media Foundation encoder, whose compressed output goes to native WebRTC. Local preview uses the same GPU source. Software or memory-input paths request CPU readback only when needed.](/diagrams/native-encode-en.svg)

</div>
<figcaption>Blue arrows carry GPU images; gray arrows carry compressed data. The dashed branch is a conditional CPU readback path, not a required step for hardware texture input.</figcaption>
</figure>

The Windows screen path keeps the texture obtained from WGC or DXGI capture. For compatible H.264/H.265 hardware encoders, GPU processing scales and rotates the image, composes the cursor when needed, and converts SDR BGRA into NV12 using the selected color matrix and range.

NVENC registers these D3D11 textures as inputs. A compatible Media Foundation transform accepts the D3D11 device through a device manager and receives texture-backed samples. Encoder selection prefers the capture adapter where supported, reducing unnecessary adapter mismatches; this does not promise arbitrary cross-GPU texture sharing.

The encoder produces compressed bytes for native WebRTC. Those bytes and transport work still involve CPU memory. GPU copies for capture ownership, format conversion, and rendering also remain. The benefit is avoiding an unnecessary round trip of full raw frames through CPU memory, not eliminating every copy or all CPU work.

Software encoding and a hardware backend's memory-input fallback can require GPU readback. A memory-input fallback does not itself prove that encoding became software: the encoder can still be a hardware implementation receiving pixels from memory. Automatic backend recovery preserves the negotiated codec where possible; an explicitly fixed codec does not gain compatibility by changing its input path.

Local GPU preview consumes the capture source directly. Displaying a preview does not require encoding that preview or creating a loopback WebRTC connection.

## Native receiving: bitstream to decoded textures {#native-decode}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="Native decoding and shared GPU presentation" tabindex="0">

![Native WebRTC delivers encoded media to the native decoder. Hardware decoding supplies D3D11 textures directly, while software-decoded frames are uploaded. Both paths feed the shared GPU presenter. Recording a received native surface separately requests bounded CPU readback.](/diagrams/native-decode-en.svg)

</div>
<figcaption>Hardware and software decoding remain native on Windows. Uploading a software-decoded frame to the GPU does not turn its decoder into a hardware decoder.</figcaption>
</figure>

The native receiver owns RTP reception, loss recovery, decoder configuration, and decoded output. The Windows client chooses this path before answering SDP. Incoming room video tracks have their own decoded output and presentation surface.

| Format                     | Current native receive path                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| H.264 and H.265 Main 8-bit | Discover installed Media Foundation decoders; a supported GPU path returns D3D11 textures                                            |
| VP9 and AV1                | Use Media Foundation when the D3D11 device exposes a matching NV12 decode profile; otherwise retain bundled native software decoding |
| VP8                        | Use native libvpx software decoding, then upload frames for GPU presentation                                                         |

Availability is probed from the installed decoder and driver, not inferred from the GPU's product name. Media Foundation's D3D11 integration requires a compatible device, decode profile, and output format; see [Microsoft's decoder integration documentation](https://learn.microsoft.com/en-us/windows/win32/medfound/supporting-direct3d-11-video-decoding-in-media-foundation).

With native texture output, Weblink retains the complete decoded frame and its sample ownership until GPU consumers finish using it. For CPU output, a bounded upload pool packs or converts the frame into NV12 and uploads it for the same presenter. A slow display does not justify accumulating an unlimited queue of decoded pictures.

Windows decoder failures stay within the native receive/recovery path. Automatic selection can try another compatible native format; a fixed unsupported codec retains its failure behavior. Browser reception remains a separate path for Web clients and supported platform fallbacks. Edge's browser codec limitations therefore do not directly describe the Windows native receiver.

## Shared GPU presentation {#gpu-presentation}

Local capture preview and native received video share the window's presenter. D3D11 handles image processing and a swap chain; DirectComposition integrates the video surface into the window. HTML continues to supply menus, buttons, layout, and remote-control interaction. [DirectComposition](https://learn.microsoft.com/en-us/windows/win32/directcomp/why-use-directcomposition-) is the composition mechanism, not the video decoder.

The frontend's video element can carry dimensions and lifecycle state while the visible image comes from the native surface beneath WebView2. Ordinary presentation IPC passes source identity and validated layout, rather than sending every frame's pixels through JavaScript.

The presenter keeps a replaceable latest frame and bounded work in flight. Frame leases remain alive until GPU completion, including during resizing or shutdown. Hiding a view can suspend its presentation work while other consumers, such as a recorder or remote viewer, continue owning the source.

Recording can introduce a different data path. A suitable local encoded source can provide compressed packets to a recorder. Recording a **received native surface** currently opens an explicit, bounded CPU readback consumer to provide real pixels to the recording path; this backend does not offer encoded receive pass-through. That extra consumer does not replace the GPU display path.

## Browser and Windows native paths compared {#comparison}

| Stage or decision     | Browser path                                                                              | Windows native path                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Capture               | Browser-managed `MediaStreamTrack` from camera or screen APIs                             | Native screen capture keeps WGC/DXGI D3D11 textures                                                          |
| Codec implementation  | Weblink requests compatible formats; the browser chooses hardware or software             | Weblink probes native encoders/decoders and can prefer or select available backends                          |
| Hardware input/output | Browser-owned surfaces and copies; no application guarantee of texture sharing            | Supported encode/decode paths explicitly retain D3D11 textures and frame ownership                           |
| CPU path              | Browser software codec when available and selected; display can still use GPU composition | Software or memory-input encoding may need readback; software decoding uploads into the shared GPU presenter |
| Presentation          | Received/captured stream → video element → browser renderer                               | Capture/decoded frame → shared D3D11 presenter → DirectComposition beneath WebView controls                  |
| Failure boundary      | Browser-dependent recovery; no software codec means no guaranteed fallback                | Windows receive recovery stays native; it does not silently switch to the browser decoder                    |

The difference is who owns the media backend and its resources, not that one path always uses the CPU and the other always uses the GPU. Browser software codecs and Weblink's native software codecs both execute on the CPU. Either receiving path can display media sent by the other when the negotiated codec and parameters match.

## What confirms the active implementation {#acceleration-evidence}

Capabilities describe possible configurations; inspect the active stream to learn what it is doing:

- `getStats()` reports the active codec through `codecId`. When exposed, outbound `encoderImplementation` and inbound `decoderImplementation` identify the selected implementation.
- `powerEfficientEncoder` and `powerEfficientDecoder` are browser assessments that can indicate acceleration, not proof of an entirely GPU-based pipeline. Privacy rules or implementation support can leave these fields absent; missing means unknown, not software.

These fields are defined in the [WebRTC statistics specification](https://www.w3.org/TR/webrtc-stats/#dom-rtcoutboundrtpstreamstats-encoderimplementation). Weblink reads the available implementation name and receive-side efficiency flag in its video statistics.

A GPU capability page or a GPU utilization graph alone does not identify a particular call's encoder or decoder. Compare the active implementation with frame progress, processing time, and dropped frames. A visible preview confirms capture/display, not remote encoding or decoding. For failed playback and codec compatibility, use the [media FAQ](../guide/faq.md#media).

## How Weblink selects a codec {#negotiation}

Selection uses the sender's actual encoders and the target receiver's declared decoders. Native screen and camera publication make this decision per receiver; different viewers can use different formats. Compatible native hardware configurations may share an encoded result, while delivery and receiver feedback remain separate.

Automatic selection follows these constraints:

1. Discover local formats from the active browser or native backend.
2. Intersect them with the target receiver's formats, excluding incompatible settings and previously rejected formats when applicable.
3. Prefer formats available through a native hardware encoder when hardware availability is supplied.
4. Within that preference, use the current video order: **AV1 → H.265 → VP9 → H.264 → VP8**.
5. Negotiate the actual SDP parameters and verify that decoding produces frames.

This order is an implementation preference, not a quality benchmark. For example, hardware H.264 can rank ahead of software AV1. A viewer that accepts only H.264 does not force another independently negotiated viewer to use it.

Unknown capability discovery uses a conservative baseline; an explicitly empty capability list means no compatible format, not “unknown.” Weblink's video baseline is H.264/VP8, corresponding to the mandatory WebRTC video formats in [RFC 7742](https://www.rfc-editor.org/rfc/rfc7742.html#section-5). Sending, receiving, and file playback remain separate support questions.

A capability announcement does not guarantee every resolution, profile, or frame rate will work. Browser capability discovery reports an optimistic set, as documented for [getCapabilities()](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/getCapabilities_static). Manual selection still needs a compatible endpoint; current browser-specific H.265 findings are maintained in the [compatibility FAQ](../guide/faq.md#hevc-browsers).

## Resolution, frame rate, bitrate, and latency {#quality}

| Setting                | What changes                                          | Tradeoff                                                             |
| ---------------------- | ----------------------------------------------------- | -------------------------------------------------------------------- |
| Resolution             | Spatial detail and pixels processed per frame         | More detail needs more processing and usually more data              |
| Frame rate             | How frequently pictures can update                    | More motion samples consume encoding, decoding, and display capacity |
| Maximum bitrate        | The encoded data budget                               | Raising it cannot create more network capacity                       |
| Encoder preset         | The backend's quality/latency/balance strategy        | Availability and effect depend on the actual encoder                 |
| Receiver quality limit | The target viewer's requested size, rate, and bitrate | It is bounded by the publisher's limits                              |

An upper limit is not a promise of constant output. Static content can legitimately produce fewer frames. Network congestion, the receiver's request, source limits, and processing capacity can all lower the result. WebRTC's [maxBitrate definition](https://www.w3.org/TR/webrtc/#dom-rtcrtpencodingparameters-maxbitrate) uses bits per second and excludes lower transport overhead.

An 8 Mbit/s media stream is about 1 MB/s of payload in decimal units, before audio and protocol overhead. Sending separate copies to several viewers adds outgoing traffic even if they share encoder work.

End-to-end delay includes capture, conversion, encoding, network transport, buffering, decoding, and presentation. A faster encoder improves one stage. Display refresh rate, FPS, a GPU utilization percentage, or a local submission-time counter alone cannot establish end-to-end latency.

For setting choices and adjustment order, use [picture and sound settings](../guide/media.md#quality).

## Color and audio boundaries {#color-and-audio}

The current native video path exposes **YUV 4:2:0, 8-bit, SDR**. NV12 is a pixel-memory layout used along that path, not a compressed codec. Choosing H.265 or AV1 does not automatically enable 10-bit HDR or 4:4:4 color. The native presenter currently accepts even dimensions up to 3840 × 2160.

Color matrix and range describe how those pixel values are interpreted. They must stay consistent through conversion, bitstream metadata, decoding, and display. The current native VP8 configuration uses BT.601 and limited range; other choices are constrained by the selected codec and backend.

Audio is negotiated separately from this GPU video pipeline. Weblink's current preference order is Opus, G.722, PCMU, then PCMA; actual availability is discovered. Opus and G.711 PCMU/PCMA are WebRTC baseline audio formats under [RFC 7874](https://www.rfc-editor.org/rfc/rfc7874.html#section-3). The Windows receive path decodes audio to bounded PCM and uses an AudioWorklet for playback, retaining mute, volume, and browser playback-policy handling.

For the complete audio path, including browser capture, WASAPI loopback, native PCM bridges, and playback controls, see [audio capture, codecs, and playback](audio.md).

## Implementation entry points {#implementation}

Paths are relative to the repository root:

| Path                                                      | Responsibility                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| `apps/web/src/libs/domain/media-codecs.ts`                | Common formats, baselines, and hardware preference               |
| `apps/web/src/libs/application/native-codec-selection.ts` | Native format selection per receiver                             |
| `apps/web/src/libs/domain/camera-publication.ts`          | Camera codec selection and browser RTP parameters                |
| `apps/web/src/libs/domain/session-media.ts`               | Browser tracks and codec negotiation                             |
| `apps/web/src/routes/home/components/video-display.tsx`   | Stream binding and video playback                                |
| `apps/web/src/libs/domain/video-stats.ts`                 | Active codec and implementation statistics                       |
| `crates/desktop-capture/src/media/windows/`               | Capture processing, NVENC/MF encoding, and input fallback        |
| `crates/desktop-capture/src/receive/`                     | Decoded output and native texture ownership                      |
| `crates/desktop-capture/src/presentation/`                | Shared compositor, software-frame upload, and recording readback |
| `apps/desktop/src/presentation.ts`                        | Binding native surfaces to frontend views                        |
| `apps/desktop/src/presentation-recording.ts`              | Explicit recording consumer for native surfaces                  |

## Choose your next step {#next-steps}

- **Choose picture quality and encoder settings for a task:** follow the [media settings guide](../guide/media.md#quality).
- **Trace sound from microphone or system capture to the output device:** read the [audio path comparison](audio.md).
- **Understand how encoded media becomes a saved recording:** continue with [recording engines and containers](media.md#recording).
- **Investigate black video, unsupported H.265, or playback failure:** use the [media FAQ](../guide/faq.md#media).
