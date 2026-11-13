# 音频采集、编解码与播放

音频具有自己的采集、编解码、传输和播放链路，不经过视频的 GPU 编码器或显示层。Weblink 的 Web 客户端使用浏览器管理音频；Windows 原生链路使用原生 libwebrtc，并通过 PCM 桥接衔接部分输入输出。桌面端的来源也可以使用浏览器发布通路，因此应按实际媒体链路区分，不能只看应用窗口。

## 沿着声音看各个阶段 {#stages}

| 阶段       | 数据与职责                                                     |
| ---------- | -------------------------------------------------------------- |
| 采集       | 获取麦克风或共享系统声音的采样；采样率和声道数描述 PCM         |
| 处理与编码 | 应用受支持的输入处理，适配采样，再编码为协商的音频格式         |
| 传输       | 通过 RTP/SRTP 传送编码音频，与视频并行，不经过信令服务转发媒体 |
| 接收与解码 | 缓冲数据包、处理丢包并重建采样                                 |
| 播放       | 调度采样、应用本地收听控制，再交给输出设备发声                 |

PCM 是音频采样在内存中的表示。Opus、G.722、PCMU 和 PCMA 是协商的网络编码格式。PCM 桥接不等于多增加一个音频编解码器，播放设备也不是解码器。

## 浏览器音频链路 {#browser}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="浏览器麦克风和屏幕声音的采集、编码、解码与播放" tabindex="0">

![麦克风采集可以应用浏览器支持的语音处理，屏幕声音则是独立且可选的音频轨道。各来源进入浏览器的 WebRTC 编码器与 RTP 传输。接收数据经过缓冲和解码，共用 audio 元素再通过选定输出设备播放接收流。](/diagrams/browser-audio-zh.svg)

</div>
<figcaption>发送端的分支表示不同来源，不表示必须把麦克风和系统声音混为一条。蓝色箭头表示未压缩音频流，灰色箭头表示编码传输。</figcaption>
</figure>

### 采集与输入处理 {#browser-capture}

麦克风在获得设备权限后通过 `getUserMedia()` 采集。浏览器声明相关约束可用时，Weblink 默认请求回声消除、降噪、自动增益和语音隔离，实际效果仍取决于浏览器和设备。屏幕声音通过 `getDisplayMedia()` 获取，与麦克风是独立来源。

Weblink 会请求屏幕声音，并提供包含系统音频的提示，但是否返回音频轨道，取决于选中的来源、操作系统、浏览器以及用户选择。只有屏幕视频轨道不代表已经采集声音。这一边界见 [getDisplayMedia() 说明](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)。

采集采样偏好使用 `ideal` 约束，设备可以返回其他受支持的采样率或声道数。屏幕声音默认请求关闭面向语音的回声消除、降噪和自动增益；麦克风与共享媒体的处理目标并不相同。

### 编码与解码 {#browser-codecs}

浏览器的 RTP sender 将采集轨道编码为与接收端协商的格式。Weblink 提供格式偏好，编码器、打包和传输由浏览器管理。普通 Web 通话不要求 Weblink 在 JavaScript 中逐块复制 PCM，也不要求通过 AudioWorklet 编码 Opus。

接收时，浏览器负责 RTP/SRTP、数据包时序、抖动缓冲、丢包掩蔽和音频解码。可用的恢复机制取决于协商格式和实现，丢失的数据不一定都能恢复。得到的音频轨道再为播放提供采样。

### 播放 {#browser-playback}

Weblink 的共用音频播放器通过 `audio.srcObject` 绑定接收轨道。来源静音、收听状态与输出设备选择，独立于发送端的采集状态。普通浏览器通路直接接入这个播放器，不需要经过应用的原生 PCM 桥接。

支持时，输出设备选择使用 `HTMLMediaElement.setSinkId()`。不支持时，应用可以使用默认输出，但不能保证切换到另一个设备。设备权限和浏览器策略仍然适用，见[输出设备接口](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/setSinkId)。

## Windows 原生音频链路 {#native}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="原生系统声音采集、WebView 麦克风桥接、原生解码与 Web Audio 播放" tabindex="0">

![WASAPI 系统回环将 PCM 直接交给原生编码。接入原生房间的麦克风则由 WebView 采集，再经过 PCM AudioWorklet 桥接。原生接收解码为有界 PCM，通过 IPC、播放 worklet 和 MediaStream destination 接入共用音频播放器及输出设备控制。](/diagrams/native-audio-zh.svg)

</div>
<figcaption>系统声音和麦克风具有不同的输入路径。原生解码在播放 worklet 之前已经完成；该 worklet 消费 PCM，不负责解码 Opus 等压缩码流。</figcaption>
</figure>

### 系统声音：从 WASAPI 到原生编码 {#native-system-audio}

原生屏幕共享包含声音时，Windows WASAPI 工作线程负责进程回环采集。Weblink 排除自身进程树，包括 WebView 子进程，避免把会议播放声音再次送回会议。这里采集的是该进程树以外的系统声音，**并非仅限选中采集窗口的声音**。Microsoft 的[进程回环示例](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)解释了这种包含与排除机制。

工作线程按已配置且受支持的采样率与声道数获取有符号 16-bit PCM，将带时间戳的 10 ms 数据块交给原生音频来源，再由 libwebrtc 编码和传输。普通系统声音发送中，PCM 留在原生侧；可选录制消费者可以另行请求自己的数据通路。

原生系统声音格式与麦克风格式分别探测。麦克风支持某种采样率，并不能证明回环采集也接受相同配置。

### 麦克风：从 WebView 采集接入原生房间 {#native-microphone}

接入 Windows 原生房间的麦克风轨道，仍从 WebView 采集开始，并遵循其权限和输入处理约束。Weblink 创建 48 kHz AudioContext，麦克风 AudioWorklet 再将浮点采样转换为交错排列的双声道有符号 16-bit PCM。有界批次通过 IPC 进入原生音频来源，由它按 10 ms 帧送入 libwebrtc。

同一采集来源可以供多个对端使用，不必为每位观看者重复采集或传递 PCM。这个桥接不会将麦克风采样播放到本地扬声器；其中的 worklet 负责适配 PCM，不是 Opus 编码器。

这里描述的是原生房间接入路径。麦克风伴随浏览器摄像头发布时，使用的仍是该浏览器 RTP sender。因此，“桌面端麦克风”不代表所有采集和编码都在 WebView 之外完成。

### 从原生解码到 Web Audio 播放 {#native-playback}

原生接收器负责 WebRTC 接收和音频解码。无论网络格式为 Opus、G.722、PCMU 还是 PCMA，输出适配器都请求 **48 kHz、双声道、有符号 16-bit PCM**。适配成这个播放格式，不会恢复来源本来没有的细节。

解码数据块进入原生有界队列。通知触发前端通过 IPC 读取 PCM，再将数据转交给接收 AudioWorklet。worklet 将采样转换为浮点格式，经 Web Audio `MediaStreamDestination` 生成音频轨道，接入 Weblink 共用的 HTML 音频播放器。

这个桥接不会再次解码 Opus，也不会重新编码为网络流。同一个播放器继续负责本地来源静音和受支持的输出设备选择。原生解码不绕过 WebView 播放策略：AudioContext 和媒体元素都需要能够正常运行。

桥接两端的队列都有限制。停顿后可以丢弃过期音频，尽快回到实时位置，避免不断积压并播放历史声音。没有可播放采样时输出静音；缓冲无法凭空补出丢失的语音。

## 浏览器与原生链路对比 {#comparison}

| 职责           | 浏览器链路                             | Windows 原生链路                                          |
| -------------- | -------------------------------------- | --------------------------------------------------------- |
| 麦克风采集     | 浏览器采集及受支持的处理约束           | WebView 采集；接入原生房间时使用 PCM 桥接                 |
| 共享系统声音   | 屏幕选择器提供的可选音频轨道           | WASAPI 进程回环，排除 Weblink 自身进程树                  |
| 编码与网络传输 | 浏览器 WebRTC 实现                     | 原生发布及房间轨道使用原生 libwebrtc                      |
| 接收采样       | 浏览器解码器向音频轨道供给数据         | 原生解码与输出适配 → 有界 PCM → IPC → AudioWorklet        |
| 播放控制       | 共用 HTML 音频播放器及受支持的输出接口 | PCM destination 轨道进入同一个播放器和输出接口            |
| 资源归属       | 浏览器管理实时媒体通路                 | Weblink 还需管理采集线程、PCM 桥接队列和 worklet 生命周期 |

Weblink 没有与 NVENC/D3D11 视频链路对应的音频 GPU 通路。原生音频编解码和显式 PCM 适配通过软件执行；浏览器或操作系统可以有自己的音频处理或设备 DSP。[AudioWorklet](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorklet) 在 Web Audio 处理线程执行，不在 GPU 上，也不在页面普通 UI 线程执行。视频硬件加速不代表音频加速，原生音频也不意味着所有环境下延迟都更低。

## 音频格式与时钟 {#formats}

Weblink 当前自动偏好顺序为 **Opus → G.722 → PCMU → PCMA**，并按实际发送端和接收端能力过滤。Opus 与 G.711 的 PCMU/PCMA 是 [RFC 7874](https://www.rfc-editor.org/rfc/rfc7874.html#section-3) 规定的 WebRTC 基线音频格式。手动选择也需要完成兼容协商。

| 格式        | RTP 时间戳时钟 | 与当前通路有关的音频特性                                  |
| ----------- | -------------- | --------------------------------------------------------- |
| Opus        | 48 kHz         | 支持语音和一般音频，音频带宽与单/双声道取决于配置         |
| G.722       | 8 kHz          | 解码音频为 16 kHz；Weblink 支持的录制映射为单声道         |
| PCMU / PCMA | 8 kHz          | G.711 μ-law / A-law 窄带音频；Weblink 映射为 8 kHz 单声道 |

RTP 时钟不一定等于采集采样率。Opus 的各种模式都使用 48 kHz 时间戳时钟（[RFC 7587](https://www.rfc-editor.org/rfc/rfc7587.html#section-4.1)）；G.722 虽然是 16 kHz 音频，仍保留 8 kHz RTP 时钟（[RFC 3551](https://www.rfc-editor.org/rfc/rfc3551.html#section-4.5.2)）。原生播放桥接输出 48 kHz 双声道，不证明来源采集或网络传输的是全频带立体声。

## 采样、处理与延迟 {#sampling-and-latency}

| 设置或阶段         | 改变什么                                           |
| ------------------ | -------------------------------------------------- |
| 采集采样率和声道数 | 编码前可用的采样；麦克风和系统采集可支持不同格式   |
| 回声消除           | 尝试去除扬声器播放后被麦克风再次采入的声音         |
| 降噪与自动增益     | 调整背景噪声或信号强度，也可能改变音乐等非语音素材 |
| 编码格式与编码码率 | 网络表示和数据预算，与 PCM 采集格式是不同参数      |
| 缓冲与播放         | 在抵抗时序波动与增加延迟之间取舍                   |

默认采样偏好为 48 kHz、双声道，不是端到端音质保证。提高请求采样率，不会改变编码的 RTP 时钟，也不保证传输更多细节。将单声道信号复制到两个 PCM 声道，也不会产生立体声录音。

总延迟包括采集数据块、处理、编码打包、网络传输、接收缓冲、可能存在的 PCM 桥接，以及设备输出。原生 10 ms 输入块不代表 RTP 包一定为 10 ms，更不代表端到端延迟为 10 ms。音频与视频也有各自的队列，画面流畅不等于声音一定及时。

## 采集静音、收听静音与本地播放抑制 {#playback-controls}

| 控制                       | 作用边界                                               |
| -------------------------- | ------------------------------------------------------ |
| 发送端麦克风或系统声音静音 | 控制该发送来源；原生回环可以保持来源存活并提交静音采样 |
| 接收端来源或成员静音       | 禁用本地收听轨道，不会关闭远端麦克风                   |
| 全局收听控制               | 暂停或恢复共用播放器，不结束发送端采集                 |
| 共享系统声音时抑制本地播放 | 改变采集机器上的本地播放，采集仍可继续                 |

最后一项在不同平台上的实现不同。浏览器只在显示采集中接收受支持的 `suppressLocalAudioPlayback` 约束。原生链路会临时静音 Windows 的活动播放端点，同时继续进程回环采集。这也可能让其他本地应用和本地会议播放静音，并不是逐窗口音量控制。采集结束时，Weblink 恢复由自己静音的端点，同时保留原先已有的静音或期间的手动取消静音。

浏览器音频和经 Web Audio 返回的原生音频都仍受[自动播放规则](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay)影响。即使已经收到媒体，也可能需要用户交互才能开始收听。没有声音时的操作检查统一放在[音频常见问题](../guide/faq.md#no-audio)中。

## 实现入口 {#implementation}

以下路径相对于仓库根目录：

| 路径                                                      | 职责                                   |
| --------------------------------------------------------- | -------------------------------------- |
| `apps/web/src/libs/application/meeting-audio-settings.ts` | 采样偏好及仅用于显示采集的本地播放抑制 |
| `apps/web/src/libs/state/create-audio-player.ts`          | 接收轨道、收听控制与输出设备选择       |
| `crates/desktop-capture/src/media/windows/audio.rs`       | 原生回环 PCM 采集与来源投递            |
| `apps/desktop/src/room/capture.ts`                        | 麦克风接入原生房间的 PCM 桥接          |
| `crates/desktop-capture/src/room_peer/source.rs`          | 原生音频来源与 PCM 帧校验              |
| `crates/desktop-capture/src/receive/output.rs`            | 原生解码音频输出及有界队列             |
| `apps/desktop/src/room/output.ts`                         | 原生房间 PCM 投递至 Web Audio          |
| `apps/desktop/src/receive-audio.worklet.js`               | 有界 PCM 播放适配                      |

## 接下来想了解什么？ {#next-steps}

- **想选择采集设备、声音设置或录制选项**：参考[音视频使用指南](../guide/media.md)。
- **想对比视频编解码和 GPU 显示通路**：阅读[编码、解码与 GPU 显示](codecs.md)。
- **想理解音频包如何进入录制文件**：继续阅读[媒体传输与录制](media.md#recording)。
- **画面正常但听不到声音**：按[音频排查步骤](../guide/faq.md#no-audio)检查。
