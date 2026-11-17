# Video statistics and latency

The performance window provides same-frame latency, interval averages, and connection probes. End-to-end latency uses one frame's capture and presentation timestamps: **browsers end at expected display; native GPU desktop ends at compositor submission**. Desktop capture uses the original OS frame time, including delivery and scheduling waits in the sender path.

## View statistics {#view}

Enable **Stream statistics** in the main picture's actions. Drag the window anywhere within the meeting, expand it, or copy statistics. The statistics window follows the main picture.

- A collapsed received picture shows presentation FPS, receive bitrate, and end-to-end latency when its timestamps are ready.
- A collapsed local picture shows the slowest available receiver's **send latency**, local presentation FPS, and total outgoing bitrate. Browser frame timing ends before packetization and is labelled **Pre-packetizer**. Hover for receiver names and measurement ranges, and expand for individual receivers. Sender metrics are calculated locally on the sender.
- Expanded reception prioritizes receive latency, receiver processing latency and display wait for the same frame. RTT remains an independent reference. Buffering, codec timings, presentation queues, and counters remain in copied and diagnostic data.

## Capture to display {#pipeline}

A frame proceeds from capture through encoding, sending, reception and presentation to visible screen output. Letters mark the timing events used by statistics, and bands mark their intervals.

**Browser end-to-end C → X = receive latency C → R + receiver processing latency R → S + display wait S → X.**

Native GPU desktop uses **C → S**.

<figure class="docs-diagram" style="--diagram-min-width:1080px">
<div class="docs-diagram-scroll" role="region" aria-label="Time points and measurement intervals from capture start to screen display" tabindex="0">

![A frame proceeds through capture start, captured frame C, pre-packetizer callback P, transport submission T, last-packet reception R, decode completion D, compositor submission S and visible screen output. Browser end-to-end covers C to X; native GPU desktop covers C to S. X is expected display time.](/diagrams/statistics-en.svg)

</div>
</figure>

### Time points {#pipeline-points}

| Variable | Meaning                 | Description                                                                                                                                                  |
| -------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| —        | Capture begins          | The device or system starts acquiring the image for this frame.                                                                                              |
| **C**    | Captured frame          | Desktop uses the original OS frame time (WGC `SystemRelativeTime` / DXGI QPC time); browsers use capture-backend `captureTime` mapped to the receiver clock. |
| **P**    | Pre-packetizer callback | Encoded output enters the callback before RTP packetization, timestamped on the sender's local clock.                                                        |
| **T**    | Transport submission    | Handoff of this frame's original RTP marker packet to the transport returns successfully, timestamped by the native sender.                                  |
| **R**    | Last packet received    | The receiver gets the frame's last packet. Browsers use `receiveTime`; desktop uses the latest reception timestamp among that frame's packets.               |
| **D**    | Decode complete         | The decoder outputs the frame, with its completion time recorded by the native receiver.                                                                     |
| **S**    | Compositor submission   | The frame is handed to the compositor. Browsers use `presentationTime`; desktop records the successful return of the submission call.                        |
| —        | Visible on screen       | The system composes the frame and scans it out according to the screen's refresh schedule.                                                                   |
| **X**    | Expected display        | The browser's `expectedDisplayTime`, estimating when this frame will appear on screen and used to calculate display wait.                                    |

### Interval calculations {#pipeline-calculation}

**Receive latency C → R** covers OS capture delivery, thread scheduling, frame preparation, encoding, output delivery, packetization, send queues, network transport and receipt of the last packet. **Receiver processing latency R → S** covers remaining assembly, buffering, decoding, texture preparation and compositor submission. The intervals meet at R; adding the same frame's display wait S → X gives browser end-to-end latency.

**Encoding takes place within C → P**. Encode latency is the mean per-frame duration from encoding work starting to output completion during the sampling interval; native hardware timing includes input-format conversion and driver work. C → P also covers preparation and waiting before encoding, output delivery and callback scheduling. The separate encode-latency value is available in copied statistics and diagnostics.

The upper **send latency C → T** is recorded by the native sender. The gray **T → R** interval marks transport submission through last-packet reception. The lower **receive latency C → R** covers sender processing and transport; **after-decode latency D → S** is recorded by the native receiver. Browser senders record **C → P**; see [same-frame sender timing](#sender-frames) for the fields.

System composition, refresh and scan-out follow S. Browsers use X for expected display time; **display wait S → X** measures the wait from compositor submission to that expected time and contributes to browser end-to-end latency.

Senders calculate C → P → T on their local clock. Receivers map C to their local clock and combine it with R, D, S and X to calculate these intervals:

```text
captureToReceiveMs = R − C
receiveToPresentMs = S − R
decodeToPresentMs = S − D
displayWaitMs = X − S

C → X: endToEndMs = X − C
       = captureToReceiveMs + receiveToPresentMs + displayWaitMs
C → S: endToEndMs = S − C
       = captureToReceiveMs + receiveToPresentMs
```

Each interval appears when the required timestamps for the same frame are ready and correctly ordered. The interface provides values and tooltips; diagnostic fields record their source and estimation basis. Interval averages track stage costs, while RTT tracks the connection's network round-trip time.

## Same-frame latency {#frame-latency}

| Metric              | Exported field        | Interval                                    | Browser                                                                     | Native GPU desktop                                                          |
| ------------------- | --------------------- | ------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| End-to-end          | `endToEndMs`          | Browser C → X; native GPU C → S             | `captureTime` → `expectedDisplayTime`                                       | WebRTC-mapped capture → successful submission call return                   |
| Receive latency     | `captureToReceiveMs`  | C → R                                       | Frame callback `receiveTime`                                                | Latest reception timestamp among this decoded frame's packets               |
| Receiver processing | `receiveToPresentMs`  | R → S                                       | Remaining buffering, decoding, post-processing, and presentation scheduling | Also includes Rust queues, texture preparation/upload, wait, and submission |
| After decode        | `decodeToPresentMs`   | D → S                                       | —                                                                           | This frame's WebRTC decoder completion; a subset of receiver processing     |
| Display wait        | `displayWaitMs`       | S → X                                       | Browser estimate, included in end-to-end                                    | —                                                                           |
| Frame decode        | `frameDecodeMs`       | This frame's decoder processing             | Browser `processingDuration`, possibly including conversion                 | Interval decode average available in diagnostics                            |
| Present wait        | `presentationQueueMs` | Published texture ready → submission starts | —                                                                           | Subset of after-decode latency                                              |
| Submit latency      | `submitMs`            | Submission starts → call returns            | —                                                                           | Subset of after-decode latency                                              |

Exports identify the endpoint with `latencyEndpoint`: `"expected-display"` in browsers and `"compositor-submit"` on native GPU desktop. Browsers show the end-to-end total once the same frame's expected display timestamp is available. End-to-end and receive latency use cross-device clock mapping, with the estimated state retained in diagnostics. Local preview provides local statistics such as FPS, presentation wait and submission duration.

Same-frame timings are valid for 1.5 seconds. Hiding, closing, or switching sources resets sampling. Browser frame age starts at the frame's submission timestamp. Desktop frame age combines native age with elapsed time after polling.

## Same-frame sender timing {#sender-frames}

Senders measure processing of the same frame separately for each receiver, using the sender's local clock. C, P and T refer to the [capture, pre-packetizer callback and transport submission events](#pipeline-points) above.

| Platform | Primary metric | Interval |
| -------- | -------------- | -------- |
| Desktop  | Send latency   | C → T    |
| Browser  | Pre-packetizer | C → P    |

<figure class="docs-diagram" style="--diagram-min-width:720px">
<div class="docs-diagram-scroll" role="region" aria-label="Same-frame sender timing intervals" tabindex="0">

![Desktop send latency covers C to T, combining capture to packetizer C to P and packetization and pacing P to T. Browser pre-packetizer latency covers C to P.](/diagrams/sender-timing-en.svg)

</div>
<figcaption>The two intervals of one frame meet at P.</figcaption>
</figure>

**Desktop send latency = capture to packetizer + packetization and pacing.**

| Component             | Interval | Processing covered                                                                                                   |
| --------------------- | -------- | -------------------------------------------------------------------------------------------------------------------- |
| Capture to packetizer | C → P    | OS capture delivery, frame preparation, encoder wait, encoding, output delivery and callback scheduling              |
| Packetize and queue   | P → T    | RTP packetization and pacing, ending at the successful return of the original marker-packet handoff to the transport |

Frame samples are valid for 1.5 seconds. The window shows current samples and stays blank after expiry while awaiting an update. Comparisons across receivers or platforms use matching C → P or C → T ranges. See [sender diagnostics](#sender-diagnostics) for exported fields, frame correlation and sampling frequency.

## Interval averages and containment {#intervals}

WebRTC counters use deltas between adjacent valid snapshots to calculate averages in milliseconds. Averages update for intervals with new samples after the baseline is established; counter resets establish a new baseline. Each average uses its stage's sampling window and counting unit to help locate processing costs.

| Metric                 | Sampling unit                        | Interval                                       | Containment                                                                                   |
| ---------------------- | ------------------------------------ | ---------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Capture/encode         | Fresh native hardware-encoder frames | Original OS frame time → encoded output        | Includes capture delivery, preparation, encoder wait, and encoding                            |
| Encoder wait           | Encoded frames                       | input ready → encoding work starts             | Inside capture/encode                                                                         |
| Encode latency         | Encoded frames                       | encoding work starts → output                  | Native hardware timing starts before input conversion and includes conversion and driver work |
| Send queue             | **Packets**                          | RTP packetizer output → OS socket handoff      | Interval average of per-packet send queues                                                    |
| First packet to decode | Decoded frames                       | **first packet** received → decoded            | Includes assembly, buffering, scheduling, and decoding                                        |
| Buffer                 | Frames emitted from jitter buffer    | first packet ingested → complete frame emitted | Inside first packet to decode; overlaps transport of later packets                            |
| Decode time            | Decoded frames                       | decoder input → completed output               | Inside first packet to decode                                                                 |
| RTT                    | Single probe                         | ICE/STUN request sent → response received      | Independent connection round-trip time                                                        |

Primary sender metrics prioritize same-frame timing. Legacy statistics estimate sender processing as capture/encode mean plus packet queue mean, or encode mean plus packet queue mean, using `sendLatencyBasis: "capture" / "encode"` and `sendLatencyState: "partial"`. Capture/encode mean includes encoder wait and encoding.

The window prioritizes the primary sender metric. Capture/encode, encoding and send queues remain in copied statistics and diagnostics; available subintervals appear while the primary value is blank. First packet to decode, buffering and decoding are described by their containment relationships. With multiple viewers, the slowest value is selected within a consistent scope; individual receiver rows retain their full-frame, pre-packetizer or legacy estimates. A scope change starts a new latency history while retaining FPS and other history. Total bitrate sums actual outgoing connections.

## Measurement scope {#coverage}

Receive latency covers OS capture delivery, thread scheduling, frame preparation, encoding, delivery, RTP packetization, pacing, OS transmission, network transport and receipt of all packets. Receiver processing latency covers remaining assembly, buffering and decoding through compositor submission. Native after-decode latency records frame handoff, texture preparation, uploads, queues and submission after decoding completes.

Each platform uses the following timing events:

- Desktop capture starts at the original OS frame time: WGC uses `SystemRelativeTime`, DXGI uses `LastPresentTime`, and cursor updates use `LastMouseUpdateTime`. These timestamps map to local `Instant` and follow the frame through GPU handoff, retained-frame replay and CPU readback. Browsers use timestamps supplied by their capture backend.
- Native presentation ends when the submission call returns successfully, followed by `wl_composition_commit`, GPU completion, refresh and scan-out. Browsers use expected display as the end-to-end endpoint and show display wait as an expanded component.
- Encoder-group `delivery` diagnostics measure output delivery to viewers and recording consumers. CPU readback, driver preparation and output waits follow the active path; resource lease duration and inter-frame intervals describe resource occupancy and processing cadence.

## Clock mapping and estimates {#clocks}

Receivers calculate same-frame latency on their local monotonic clock. Browsers supply `captureTime` mapped to the receiver clock. Native reception uses WebRTC RTP/RTCP capture mapping, then bridges it into local `Instant`. Reception and decoder timestamps share this mapping, using clock samples whose reads span at most 2 ms.

Native software and hardware sources use the same WebRTC monotonic capture clock, preserving elapsed time between the original OS frame and submission. Retained frames captured before an encoder worker starts keep their original time. QPC ticks use the system frequency; WGC timestamps use 100 ns units. Clock reads are anchored at the midpoint of bracketing Instants, and capture-clock bridges retry reads exceeding 2 ms. Encoders receive absolute monotonic microsecond timestamps, which continue through encoded output. Corresponding latency metrics become available when synchronization, required fields and timestamp ordering are valid. Network asymmetry, timestamp precision and clock mapping contribute to the estimate.

Native static repeats use the repeated input's timestamp; capture/encode averages use fresh captures. End-to-end describes each media-frame delivery from capture to its labelled presentation endpoint. When photographing a continuous timer, compare multiple frames from the same period with end-to-end, receive, receiver-processing and display-wait values; the two screens' refresh phases and scan positions also affect the photographed difference.

## FPS, 1% Low, and bitrate {#rates}

Presentation FPS counts compositor submissions, while decode FPS counts decoder output. 1% Low is the reciprocal of the mean slowest 1% of completed frame intervals during the last ten seconds of visible playback. It starts at zero and updates as frame intervals complete; the interface and diagnostic fields describe player capability and estimation state. Coalesced browser callbacks and bounded sampling retain the estimated state.

Bitrate uses byte deltas over actual sampling time, while target bitrate and available bandwidth describe transport budgets. History charts leave gaps at sampling interruptions. Copied statistics and diagnostics retain counters, histories, measurement ranges and native detail to help locate jitter and processing costs.

## Implementation and standards {#sources}

### Sender diagnostics {#sender-diagnostics}

Copied and detailed diagnostics retain `sendFrame`, SSRC, RTP timestamp and `ageMs`. RTP timestamps identify frames, durations use the local monotonic clock, and `ageMs` records sample age. Same-frame primary values use `sendLatencyBasis: "frame"`, with these sources and endpoints:

| Diagnostic field       | Desktop            | Browser                 |
| ---------------------- | ------------------ | ----------------------- |
| `sendLatencyMs` source | `captureToSendMs`  | `captureToPacketizerMs` |
| `sendLatencyEndpoint`  | `transport-submit` | `packetizer-input`      |
| `sendLatencyState`     | `measured`         | `partial`               |

Raw components use timestamps from the same frame:

```text
captureToPacketizerMs = P − C
packetizerToSendMs = T − P
captureToSendMs = T − C
captureToSendMs = captureToPacketizerMs + packetizerToSendMs
```

Native timing correlates frames by connection and SSRC. Original marker-packet submission produces one completed sample and removes its pending entry; pending tracking retains up to 512 entries for ten seconds. Browsers reuse the encoded Worker and publish a timing snapshot at most every 250 ms, including message-delivery time in sample age. Timing continues when recording pauses, and connection teardown releases observers and Workers.

### Code and standards {#source-references}

- Same-frame calculation: `apps/web/src/libs/domain/video-frame-latency.ts` and `video-presentation-stats.ts`.
- Sender frame timing: `apps/web/src/libs/domain/video-send-frame-stats.ts` and `rtp-encoded-media.worker.ts`; the shared contract is `packages/platform/src/send-frame-stats.ts`. The native SDK matches encoded frames to original marker-packet transport events per connection.
- Interval counters: `apps/web/src/libs/domain/video-stats.ts`.
- Native frame timing and submission: `crates/desktop-capture/src/receive/` and `presentation/`; shared contract: `packages/platform/src/presentation-stats.ts`.
- [WebRTC Stats](https://www.w3.org/TR/webrtc-stats/) defines first-packet-to-decode, jitter buffering, encoding, and packet send queues.
- [Video frame callbacks](https://wicg.github.io/video-rvfc/) defines last-packet reception, compositor submission, and expected display.
- [WebRTC Encoded Transform](https://www.w3.org/TR/webrtc-encoded-transform/) defines capture-time metadata at encoded callbacks, used for browser C → P timing.

When tuning quality or codecs, use [encoding and GPU presentation](codecs.md#quality) to inspect changes in individual stages and total latency.
