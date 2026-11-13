# 编码、解码与 GPU 显示

Weblink 同时具有浏览器媒体链路，以及 Windows 原生发送和接收链路。采集、编码、解码和显示是不同阶段，各自有独立的加速条件。浏览器管理自己的编解码器与渲染器；Windows 原生后端则可以在采集、受支持的硬件编解码器和共用显示层之间传递 GPU 纹理。

## 编码格式、编解码器与显示层 {#roles}

| 名称     | 负责什么                           | 例子                                             |
| -------- | ---------------------------------- | ------------------------------------------------ |
| 编码格式 | 规定媒体如何表示为压缩数据         | H.264/AVC、H.265/HEVC、VP8、VP9、AV1             |
| 编码器   | 将原始画面转换成压缩码流           | NVENC、Media Foundation 编码器或原生软件编码器   |
| 解码器   | 从码流重建画面                     | Media Foundation 解码器或内置原生软件解码器      |
| 显示层   | 将解码或采集得到的画面呈现在窗口中 | Windows 端的 D3D11 处理与 DirectComposition 合成 |
| 文件容器 | 在文件中组织录制轨道与时间信息     | MP4、MKV、WebM                                   |

选择 H.264 是选择格式，不是指定某一个编码器实现。原生代码也可以在 CPU 上进行软件解码，解码结果上传后同样能够通过 GPU 显示。这几种能力需要分别看待。

WebRTC 通过 RTP 传输压缩媒体，由另一台设备重建像素，并不把发送方的 GPU 纹理传到远端。录制容器又是另外一层，见[媒体传输与录制](media.md#recording)。

## 视频编码压缩了什么 {#compression}

视频编码会利用一幅画面内部，以及前后画面之间的相似性。关键帧提供新的解码起点，预测帧则复用参考信息。场景切换和复杂运动通常比静止桌面需要更多数据；有损压缩通过舍弃部分细节缩小码流。基础概念可参见 [MDN 视频编码指南](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Video_codecs)。

关键帧有助于新观看者或恢复中的解码器正确起步，但也可能带来较大的瞬时数据量。Weblink 会按需请求恢复关键帧；降低码率不会让每幅画面都变成可以独立解码的图片。具体参考关系和关键帧策略取决于编码器。

原始像素与编码码率的数量级很不同。以 1920 × 1080、每个 BGRA 像素四字节、每秒 60 幅完整画面计算，单次原始帧拷贝对应的数据量约为 **498 MB/s**。这只是字节量示例，不是吞吐实测或网络要求。因此，避免反复执行原始帧的 GPU → CPU → GPU 搬运，与降低压缩后的网络码率，是不同的优化方向。

## 浏览器的采集、编解码与显示 {#browser-path}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="浏览器发送、接收与有条件使用的软件通路" tabindex="0">

![浏览器采集产生供本地预览与 WebRTC 发送使用的轨道，由浏览器选择硬件或 CPU 编码。接收端经硬件或 CPU 解码后向视频轨道提供画面，再由 video 元素显示。GPU 合成与软件渲染是独立的显示选择。](/diagrams/browser-media-zh.svg)

</div>
<figcaption>图中表示逻辑媒体流，不承诺每条箭头都传递 GPU 纹理。虚线表示有条件使用的软件实现，既可能在启动时选中，也可能在硬件失败后启用。</figcaption>
</figure>

### 发送：从采集轨道进入 WebRTC {#browser-encode}

Weblink 通过 `getUserMedia()` 获取摄像头和麦克风轨道，通过 `getDisplayMedia()` 获取屏幕轨道。视频轨道经 RTP sender 接入 `RTCPeerConnection`。Weblink 设置编码偏好以及受支持的分辨率、帧率和码率限制，由浏览器完成画面适配、编码与 RTP/SRTP 传输。

`setCodecPreferences()` 影响与对端协商的格式，不能让 Weblink 指定 NVENC、某张显卡或某个软件编码器。浏览器通路也没有向 Weblink 的编码选择逻辑提供原生硬件优先级。接口边界见 [WebRTC 编码偏好定义](https://www.w3.org/TR/webrtc/#dom-rtcrtptransceiver-setcodecpreferences)。

本地预览直接将采集流绑定到视频元素，不需要先编码再解码。Weblink 的普通浏览器通话链路不在 JavaScript 中压缩原始画面；即使使用 CPU 编解码，通常也是浏览器内部的媒体实现负责执行。为[录制](media.md#recording)读取编码包，是对已编码媒体增加一个消费者。

### 接收：从 WebRTC 解码到视频元素 {#browser-decode}

浏览器接收并解密媒体，管理抖动缓冲与丢包恢复，再解码协商得到的码流。Weblink 将接收到的 `MediaStream` 绑定到 `video.srcObject`。轨道为显示提供解码后的画面，视频元素不需要再经历一轮编码与解码。

硬件解码器可以提供由 GPU 资源承载的画面；软件解码器输出 CPU 可访问的像素，随后仍可能上传给 GPU 合成。浏览器负责这些资源、转换与拷贝，Weblink 不管理其中的 D3D11 纹理，也不承诺整条链路零拷贝。

GPU 合成与硬件解码是不同能力。CPU 解码的视频仍然可以显示在 GPU 合成的页面中；加速合成不可用时，浏览器也可能使用软件渲染通路。Chromium 的[合成架构说明](https://www.chromium.org/developers/design-documents/gpu-accelerated-compositing-in-chrome/)解释了这种显示层区别，具体资源通路随浏览器和平台变化。

## 浏览器何时使用硬件加速或 CPU {#browser-acceleration}

这里的“GPU 加速”也包括 GPU 或 SoC 内专用的视频处理单元，不只是 3D 渲染核心。编码、解码和合成各自独立：某个格式能够硬件解码，不代表同一设备也能对它进行硬件编码。

| 条件                                                                   | 浏览器可能采用的行为                                                 |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| 协商格式、profile 与请求配置符合可用硬件后端的能力，驱动正常且允许加速 | 可以选择硬件编码或解码，CPU 仍参与控制和传输                         |
| 硬件不支持、当前浏览器或构建未开放，或被设置、驱动策略禁用             | 有兼容的软件实现时使用 CPU；否则该格式或配置不可用                   |
| 硬件初始化失败，或后端请求软件回退                                     | 兼容的软件编解码器能够初始化时，浏览器可能切换实现，但不保证恢复成功 |
| 浏览器的选择策略认为软件更适合当前负载或所需特性                       | 即使存在硬件编码器，也可能从一开始就使用 CPU 编码                    |

这些是需要区分的条件，并非所有浏览器统一承诺的回退算法。例如，libwebrtc 分别实现了[编码器的软件回退与选择](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/video_encoder_software_fallback_wrapper.cc)和[解码器的软件回退](https://webrtc.googlesource.com/src/+/refs/heads/main/api/video_codecs/video_decoder_software_fallback_wrapper.cc)。后端可用性和驱动限制也与平台有关，Chromium 的[视频加速说明](https://chromium.googlesource.com/chromium/src/+/HEAD/docs/gpu/vaapi.md)提供了相关例子。

软件回退的前提是能够处理**同一条已协商码流**。H.265 解码器不可用时，不能悄悄改用 H.264 解码器读取它；改用另一种格式需要兼容的协商或重新开始发布。硬件资源失败也可能直接导致中断；CPU 路径处理不及时则可能降低实际画质或帧率，都不保证无缝切换。

Weblink 的浏览器通话链路没有“强制 GPU”开关。WebCodecs 的 `hardwareAcceleration` 是针对其自身编解码器实例的另一套提示，不会配置 `RTCPeerConnection`。文件播放、WebCodecs 与 WebRTC 的支持情况需要分别判断，参见 [WebCodecs 硬件加速定义](https://www.w3.org/TR/webcodecs/#hardware-acceleration)。

## 原生发送：从 GPU 采集到压缩码流 {#native-encode}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="原生采集、GPU 编码与回退通路" tabindex="0">

![原生采集产生 D3D11 纹理，GPU 预处理后交给 NVENC 或兼容的 Media Foundation 编码器，压缩输出送入原生 WebRTC。本地预览使用同一 GPU 来源，软件或内存输入通路仅在需要时请求 CPU 回读。](/diagrams/native-encode-zh.svg)

</div>
<figcaption>蓝色箭头表示 GPU 图像，灰色箭头表示压缩数据。虚线是有条件使用的 CPU 回读分支，不是硬件纹理输入的必经步骤。</figcaption>
</figure>

Windows 屏幕链路保留 WGC 或 DXGI 采集得到的纹理。对于兼容的 H.264/H.265 硬件编码器，GPU 负责缩放、旋转、按需合成光标，并根据所选色彩矩阵与范围，将 SDR BGRA 转换为 NV12。

NVENC 将这些 D3D11 纹理注册为输入；兼容的 Media Foundation 变换通过设备管理器接入 D3D11 设备，接收纹理支持的样本。条件允许时，编码器选择会优先匹配采集所在的显卡适配器，减少不必要的适配器错配，但不承诺任意跨 GPU 纹理共享。

编码器生成压缩字节后交给原生 WebRTC，这些字节和传输工作仍涉及 CPU 内存。采集归属、格式转换和渲染所需的 GPU 内部拷贝也仍然存在。这里减少的是完整原始帧绕行 CPU 内存的开销，不是消除所有拷贝或 CPU 工作。

软件编码和硬件后端的内存输入回退可能需要 GPU 回读。回退到内存输入，并不自动意味着变成软件编码：编码器仍可能是接收内存像素的硬件实现。自动后端恢复会尽可能保持已协商的编码格式；显式固定的编码不会因为输入方式改变，就获得对端原本没有的兼容性。

本地 GPU 预览直接消费采集来源。仅显示预览，不需要把预览再编码一遍，也不需要创建环回 WebRTC 连接。

## 原生接收：从码流到解码纹理 {#native-decode}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="原生解码与共享 GPU 显示通路" tabindex="0">

![原生 WebRTC 将编码媒体交给原生解码器。硬件解码直接提供 D3D11 纹理，软件解码帧则上传到 GPU，两条通路进入同一个 GPU 呈现层。录制收到的原生画面时，另行请求有界 CPU 回读。](/diagrams/native-decode-zh.svg)

</div>
<figcaption>Windows 的硬件和软件解码都留在原生链路中。将软件解码帧上传给 GPU 显示，不会把解码器本身变成硬件解码器。</figcaption>
</figure>

原生接收器负责 RTP 接收、丢包恢复、解码器配置和解码输出。Windows 客户端在回答 SDP 前就选择这条通路，房间内每条入站视频轨道具有自己的解码输出与呈现表面。

| 格式                      | 当前原生接收通路                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------- |
| H.264 与 H.265 Main 8-bit | 探测已安装的 Media Foundation 解码器，受支持的 GPU 通路输出 D3D11 纹理              |
| VP9 与 AV1                | D3D11 设备具有匹配的 NV12 解码配置时使用 Media Foundation，否则保留内置原生软件解码 |
| VP8                       | 使用原生 libvpx 软件解码，再将画面上传给 GPU 呈现                                   |

可用性来自对已安装解码器和驱动的探测，不根据显卡名称直接推断。Media Foundation 的 D3D11 集成要求设备、解码配置与输出格式匹配，参见 [Microsoft 解码器集成说明](https://learn.microsoft.com/en-us/windows/win32/medfound/supporting-direct3d-11-video-decoding-in-media-foundation)。

输出原生纹理时，Weblink 会保留完整解码帧及其样本归属，直到 GPU 消费者使用结束。输出 CPU 像素时，则通过有界上传池将其打包或转换为 NV12，上传后交给同一个显示层。显示端较慢，不应导致解码画面无限排队。

Windows 上的解码失败仍由原生接收与恢复链路处理。自动选择可以尝试另一种兼容的原生格式；固定且不受支持的编码保持失败语义。浏览器接收是 Web 客户端及支持回退的平台所使用的另一条通路，因此不能直接用 Edge 浏览器的编码限制推断 Windows 原生接收能力。

## 共用的 GPU 显示层 {#gpu-presentation}

本地采集预览和原生接收视频共用窗口的呈现器。D3D11 负责图像处理与交换链，DirectComposition 将视频表面合成到窗口中；HTML 继续提供菜单、按钮、布局与远程控制交互。[DirectComposition](https://learn.microsoft.com/en-us/windows/win32/directcomp/why-use-directcomposition-) 负责合成，不承担视频解码。

前端的视频元素可以承载尺寸与生命周期状态，而真正可见的画面来自 WebView2 下方的原生表面。正常呈现时，IPC 传递来源标识与经过验证的布局，不需要把每一帧像素送到 JavaScript 再显示。

呈现器保留可替换的最新帧，并限制正在处理的任务数量。即使视图缩放或关闭，帧的使用租约也会保持到 GPU 完成。隐藏视图可以暂停该视图的呈现工作，但录制器或远端观看者等其他消费者仍可继续持有来源。

录制可能增加另一条数据通路。合适的本地编码来源可以向录制器提供压缩包；录制**接收到的原生画面**时，当前实现会显式开启有界 CPU 回读消费者，为录制通路提供真实像素，该后端尚未提供接收编码流直通。新增录制消费者不会替换原有 GPU 显示通路。

## 浏览器与 Windows 原生链路对比 {#comparison}

| 环节或决策   | 浏览器链路                                                | Windows 原生链路                                                             |
| ------------ | --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 采集         | 浏览器管理来自摄像头或屏幕 API 的 `MediaStreamTrack`      | 原生屏幕采集保留 WGC/DXGI D3D11 纹理                                         |
| 编解码器实现 | Weblink 请求兼容格式，由浏览器选择硬件或软件实现          | Weblink 探测原生编解码器，可以优先使用或指定可用后端                         |
| 硬件输入输出 | 浏览器管理表面与拷贝，应用不保证纹理共享                  | 受支持的编解码通路显式保留 D3D11 纹理与帧归属                                |
| CPU 通路     | 软件编解码器可用且被选中时使用 CPU，显示仍可使用 GPU 合成 | 软件或内存输入编码可能需要回读；软件解码输出上传到共用 GPU 显示层            |
| 显示         | 接收或采集流 → 视频元素 → 浏览器渲染器                    | 采集或解码帧 → 共用 D3D11 呈现器 → WebView 控件下方的 DirectComposition 表面 |
| 失败边界     | 恢复方式由浏览器决定，没有软件编解码器时不保证回退        | Windows 接收恢复留在原生链路，不会悄悄切换为浏览器解码                       |

两者的区别在于媒体后端和资源由谁管理，不能简单划分成“浏览器用 CPU、原生用 GPU”。浏览器的软件编解码器与 Weblink 的原生软件编解码器都在 CPU 上执行。只要协商格式与参数兼容，两种链路也可以互相收发媒体。

## 如何判断当前使用的实现 {#acceleration-evidence}

能力列表描述可能支持的配置，判断实际工作方式需要观察活动流：

- `getStats()` 通过 `codecId` 关联当前格式。浏览器提供时，发送侧的 `encoderImplementation` 和接收侧的 `decoderImplementation` 标识所选实现。
- `powerEfficientEncoder` 与 `powerEfficientDecoder` 是浏览器给出的能效判断，可以作为加速线索，不证明整条链路都在 GPU 上。隐私规则或实现支持情况可能使字段缺失；缺失表示未知，不能直接判定为软件处理。

这些字段定义在 [WebRTC 统计规范](https://www.w3.org/TR/webrtc-stats/#dom-rtcoutboundrtpstreamstats-encoderimplementation)中。Weblink 的视频统计会读取可用的实现名称及接收侧能效标记。

单独查看 GPU 能力页面或 GPU 占用曲线，不能确认某次通话的编解码器。应结合活动实现、帧数进展、处理耗时与丢帧情况判断。本地预览可见只说明采集与显示工作，不能证明远端编码或解码成功。播放失败与编码兼容问题请统一参考[媒体常见问题](../guide/faq.md#media)。

## Weblink 如何选择编码 {#negotiation}

选择依据是发送端实际可用的编码器，以及目标接收端声明的解码能力。原生屏幕和摄像头发布按接收方分别决策，不同观看者可以使用不同格式。配置兼容的原生硬件通路可以共享编码结果，但投递与接收方反馈仍然独立。

自动选择遵循以下约束：

1. 从当前浏览器或原生后端探测本地格式。
2. 与目标接收端支持的格式取交集，并按需排除不兼容设置或已经失败的格式。
3. 获得原生硬件可用性信息时，优先选择可由硬件编码器处理的格式。
4. 在此前提下，按当前视频顺序选择：**AV1 → H.265 → VP9 → H.264 → VP8**。
5. 协商实际 SDP 参数，并确认解码确实产生画面。

这个顺序是实现偏好，不是画质排行榜。例如，硬件 H.264 可以排在软件 AV1 前面。某位观看者只能接收 H.264，也不要求另一条独立协商的观看连接同时改成 H.264。

能力探测未知时使用保守基线；明确返回空能力列表则表示没有兼容格式，不能当作“未知”。Weblink 的视频基线为 H.264/VP8，对应 [RFC 7742](https://www.rfc-editor.org/rfc/rfc7742.html#section-5) 中的 WebRTC 必备视频格式。发送、接收与文件播放仍是三种不同的支持范围。

能力声明不保证任意分辨率、编码 profile 或帧率都能工作。浏览器能力查询返回的是乐观支持集合，见 [getCapabilities() 说明](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpSender/getCapabilities_static)。手动指定编码仍需兼容端点；具体浏览器的 H.265 验证情况统一维护在[兼容性问题](../guide/faq.md#hevc-browsers)中。

## 分辨率、帧率、码率与延迟 {#quality}

| 设置         | 改变什么                         | 取舍                                         |
| ------------ | -------------------------------- | -------------------------------------------- |
| 分辨率       | 空间细节及每帧处理的像素数量     | 更多细节需要更多处理能力，通常也需要更多数据 |
| 帧率         | 画面可以更新的频率               | 更多运动采样会占用编码、解码与显示能力       |
| 最大码率     | 编码数据预算                     | 提高上限不能增加实际网络容量                 |
| 编码预设     | 后端在画质、延迟与平衡之间的策略 | 是否可用及实际效果取决于具体编码器           |
| 接收质量限制 | 当前观看者请求的尺寸、帧率与码率 | 仍受发送方上限约束                           |

上限不代表恒定输出，静止内容产生较少帧是正常情况。网络拥塞、接收方请求、来源限制和处理能力，都可能让实际结果降低。WebRTC 的 [maxBitrate 定义](https://www.w3.org/TR/webrtc/#dom-rtcrtpencodingparameters-maxbitrate) 使用每秒比特，不包含下层传输开销。

按十进制单位计算，8 Mbit/s 的媒体流约为 1 MB/s 有效数据，此外还有音频与协议开销。分别发送给多位观看者时，即使共享编码工作，上行流量仍会增加。

端到端延迟包括采集、转换、编码、网络传输、缓冲、解码和呈现。更快的编码器只改善其中一个阶段，不能仅凭显示器刷新率、FPS、GPU 占用百分比或本地提交耗时，就判断端到端延迟。

实际设置选择与调整顺序见[画质与声音设置](../guide/media.md#quality)。

## 色彩与音频边界 {#color-and-audio}

当前原生视频通路提供 **YUV 4:2:0、8-bit、SDR**。NV12 是其中使用的像素内存布局，不是压缩编码格式。选中 H.265 或 AV1，不会自动启用 10-bit HDR 或 4:4:4 色彩；当前原生呈现接受偶数尺寸，最高为 3840 × 2160。

色彩矩阵与范围决定如何解释这些像素值，需要在转换、码流元数据、解码和显示之间保持一致。当前原生 VP8 配置使用 BT.601 和有限范围，其他选择也受所选编码与后端约束。

音频与这条 GPU 视频通路分别协商。Weblink 当前偏好顺序为 Opus、G.722、PCMU、PCMA，实际可用项通过探测得到。Opus 和 G.711 的 PCMU/PCMA 属于 [RFC 7874](https://www.rfc-editor.org/rfc/rfc7874.html#section-3) 规定的 WebRTC 基线音频格式。Windows 接收端将音频解码为有界 PCM，再通过 AudioWorklet 播放，继续遵循静音、音量和浏览器播放策略。

完整音频链路，包括浏览器采集、WASAPI 回环、原生 PCM 桥接与播放控制，见[音频采集、编解码与播放](audio.md)。

## 实现入口 {#implementation}

以下路径相对于仓库根目录：

| 路径                                                      | 职责                              |
| --------------------------------------------------------- | --------------------------------- |
| `apps/web/src/libs/domain/media-codecs.ts`                | 公共格式、基线与硬件偏好          |
| `apps/web/src/libs/application/native-codec-selection.ts` | 按接收方选择原生编码              |
| `apps/web/src/libs/domain/camera-publication.ts`          | 摄像头编码选择与浏览器 RTP 参数   |
| `apps/web/src/libs/domain/session-media.ts`               | 浏览器轨道与编码协商              |
| `apps/web/src/routes/home/components/video-display.tsx`   | 媒体流绑定与视频播放              |
| `apps/web/src/libs/domain/video-stats.ts`                 | 活动编码与实现统计                |
| `crates/desktop-capture/src/media/windows/`               | 采集处理、NVENC/MF 编码与输入回退 |
| `crates/desktop-capture/src/receive/`                     | 解码输出与原生纹理归属            |
| `crates/desktop-capture/src/presentation/`                | 共用合成器、软件帧上传与录制回读  |
| `apps/desktop/src/presentation.ts`                        | 原生表面与前端视图绑定            |
| `apps/desktop/src/presentation-recording.ts`              | 原生表面的显式录制消费者          |

## 接下来想了解什么？ {#next-steps}

- **想按使用场景选择画质和编码设置**：参考[音视频设置指南](../guide/media.md#quality)。
- **想沿着声音追踪麦克风或系统采集到输出设备的过程**：阅读[音频链路对比](audio.md)。
- **想理解编码媒体如何变成录制文件**：继续阅读[录制引擎与文件容器](media.md#recording)。
- **遇到黑屏、H.265 不支持或播放失败**：按[媒体常见问题](../guide/faq.md#media)排查。
