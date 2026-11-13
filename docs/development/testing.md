# 测试与验证

Weblink 按**测试边界**划分正确性测试，而非按实现功能划分，目的是将快速、确定性的反馈与真实浏览器冒烟覆盖、性能测量分开。

以下命令在仓库根目录执行，会委托给 `apps/web`，保留原有相对测试、配置路径的含义。本页应用测试和脚本路径均相对于 `apps/web/`。两个服务器子模块有独立依赖与检查，参阅[工作区开发](workspace.md)。

视觉外观由人工验收。新 UI 测试应聚焦行为、权限、状态转换和资源清理，普通布局、样式调整不新增截图或 CSS 几何断言。

## 测试分层 {#test-layers}

### 单元测试 {#unit-tests}

位置：`test/unit/`

单元测试隔离验证一个模块或小契约，优先使用普通值、fake 和注入依赖，避免编排浏览器、网络。

典型对象：

- 协议解析器与编解码器
- 纯投影和工具函数
- 独立领域控制器
- 注入 fake 的单个应用服务
- 本地流与 ICE 诊断策略
- 二进制包布局与校验

运行：

```sh
bun run test:unit
```

单元测试不应要求真实 `RTCPeerConnection`、IndexedDB 事务、模块 Worker，或渲染多个组件的完整应用流程。

### 集成测试 {#integration-tests}

位置：`test/integration/`

集成测试组合验证多个 Weblink 模块，可使用 jsdom、Solid 渲染、fake RTC 传输或通道、响应式 store 或内存仓库，但保持确定性，并在本进程内运行。

典型对象：

- 房间、会话生命周期所有权
- 类型化 P2P 请求、响应流程
- 消息服务与消息存储集成
- 文件传输服务与注册表行为
- 从消息、传输派生的任务状态
- 渲染后的对话框、设置、组件
- 使用 fake WebSocket 的信令客户端生命周期
- 成对 fake 通道上的测速服务行为

运行：

```sh
bun run test:integration
```

共享 fake 位于 `test/support/`。设备权限与配对 UI 测试使用 `test/support/peer-trust.ts` 的 `createPeerTrustMock`，实现公开服务契约，使 API 变化在类型检查时暴露，而不是留下不完整、无类型的 UI 替身。
消息存储测试使用 `test/support/message-repository.ts` 中的 `createMessageRepository`，默认写入会序列化、克隆记录，读取返回独立值。只有刻意测试失败、延迟或旧数据加载时才覆盖方法。同一仓库值契约同时针对这个 fixture 和真实 Chromium IndexedDB 运行；空写入 mock 无法验证响应式模型序列化。

默认正确性套件同时运行单元与集成测试：

```sh
bun run test
```

CI 将单元、集成测试分成独立步骤，便于定位失败边界。Vitest 在 Node 24 下运行，即使用 Bun 调用也一样；CI 在检查前选择该版本，让 fake IndexedDB 中的 `structuredClone(File)` 保留文件元数据。真实 Chromium 迁移覆盖负责验证浏览器契约。
共享 Checks 任务只运行一次 Web、桌面 TypeScript 检查、桌面适配器测试，以及 Chromium 缓存迁移、会话存储和私聊回归。开发 Web 部署与 Windows 开发构建依赖该任务。`web-dev.yml`、`web-production.yml`、`desktop-dev.yml`、`desktop-production.yml` 是由 `ci.yml` 调用的可复用工作流；开发在 `public` 推送时运行，桌面开发也验证 PR，生产在稳定版本标签上运行。Windows 开发任务在构建程序前运行 Rust 格式与原生测试。稳定标签仅验证发布元数据并构建生产产物，不重跑这些套件或编译 full-LTO 测试二进制，因此须先在分支 CI 验证提交。
开发拖放检查直接运行 Cargo 构建元数据报告的测试程序，不再次启动 Cargo 构建。

本地迭代先运行受影响测试，完整跨平台检查交给 CI。只有失败或新修改有依据时才重复检查未变化层。更新器的回环 HTTP fixture 位于仓库相对路径 `apps/desktop/src-tauri/src/updates/test_http.rs`，只依赖 Rust 标准库，可用 `rustc --test` 运行，无需编译 Tauri 和媒体 crate。Windows 开发 CI 在原生构建前检查它，Cargo 正常套件也包含它。Socket 测试显式控制阻塞模式、处理分片请求并限制 I/O；本地 fixture HTTP 客户端禁用代理，但不修改进程全局代理配置。

原生任务生命周期测试按需编译一个只依赖标准库的小型子进程，在整个套件共享，以真实管道、退出码、超时和进程取消验证行为，避免反复启动 PowerShell。单独的真实 Shell 冒烟测试覆盖脚本执行。Windows 上因为 PowerShell/CLR 冷启动依赖主机镜像和负载，该测试需显式启用；Unix 默认运行。Windows 显式命令如下：

```sh
cargo test --locked -p weblink-desktop --lib automation::jobs::tests::real_shell_executes_scripts_and_captures_output -- --exact --ignored --nocapture
```

默认正确性测试应断言事件顺序、所有权和清理，不断言解释器启动速度、GPU 延迟或固定空闲状态读取次数。使用完成通知同步 worker；超时只限制死锁和测试清理。依赖主机的性能测量和 Windows Shell 冒烟保持可选。空闲主机测量仍以 `idle_host_status_reads` 提供。

### 浏览器 E2E 冒烟测试 {#browser-e2e-smoke-tests}

位置：`test/e2e/smoke/`

这些检查通过 CDP 启动一次性的无头 Chromium 配置和本地 Vite 服务，验证 jsdom、fake 无法证明的真实浏览器原语：

- 真实 `RTCPeerConnection` 和 `RTCDataChannel`
- 真实 IndexedDB
- 真实模块 Worker
- 压缩、解压 worker
- Chromium 中渲染的任务、诊断 UI
- 聊天滚动容器、布局驱动的跟随底部与阅读锚点

这些是**冒烟测试**，不是主要的穷尽式回归套件。每项通过少量场景覆盖一个高价值子系统端到端路径。

在仓库根目录运行 `node apps/web/scripts/run-messaging-check.mjs`，会在临时本地端口启动真实应用、Bun 信令服务器和两个隔离 Chromium 上下文。它通过应用服务验证自动首次配对、受信任就绪通道及默认内容接收，分别在空历史和重新加载持久历史后检查私聊文本、文件发送，覆盖自动信任与权限恢复、房间成员关系、回执、草稿清除和下载文件内容。要求 Node 22+、Bun 和 Chromium，可用 `CHROMIUM_PATH` 选择浏览器。配置、Vite 缓存与服务器进程都是一次性的，不连接已部署信令。

`bun run test:e2e:hmr` 还需要 `rsync`。它将应用复制到临时接收工作区，使用两个 Chromium 客户端、本地信令、摄像头和麦克风采集运行真实组合层。批量视图同步期间必须保留应用所有者、房间、轨道和连接 peer，RTP 持续运行。上下文与视图定义一起抵达时，必须通过原生入口依赖重建，不能出现缺失上下文错误。测试也验证根销毁，不修改源工作区。

`bun run test:e2e:clipboard` 验证 Chromium 标准文本剪贴板互操作：从 Ctrl+C 启动 promise 写入，将数据延迟到临时激活之后，再以真实 Ctrl+V 粘贴事件核对 Unicode 文本和换行，不使用自定义格式。一次性浏览器上下文会授予本地测试源剪贴板权限。
`bun run test:e2e:clipboard-cache` 通过真实 WebRTC 数据通道、压缩与指纹 Worker、VFS 缓存和 IndexedDB，将多分块远端文件复制到文件缓存。在已收到 8 MiB 后重置控制器输入 epoch，再逐字节验证 12 MiB 文件及双方成功完成。还通过 RemoteFileDrop 反向传输，检查原生适配器参数与应用后的完成状态。浏览器测试使用原生适配器 fixture；可选 Rust `file_drop::windows::tests` 在两个 STA 线程间运行真实 OLE，验证 CF_HDROP 文件字节和剪贴板未变化。原生测试打开自己的临时目标窗口，并移动、恢复指针。

`node scripts/run-browser-check.mjs --transfer --legacy-abort` 在 `AbortSignal.any` 不可用的环境运行文件流程，模拟 Safari 16 至 17.3 的 API 条件。这验证兼容路径，不能代替 iPhone 测试。

命令：

```sh
bun run test:e2e:protocol
bun run test:e2e:recovery
bun run test:e2e:native-screen
bun run test:e2e:playback
bun run test:e2e:transfer
bun run test:e2e:cache
bun run test:e2e:tasks
bun run test:e2e:chat
bun run test:e2e:conversations
bun run test:e2e:meeting
bun run test:e2e:hmr
bun run test:e2e:speed
```

`test:e2e:cache` 检查 VFS 数据页和旧逐文件 IndexedDB 自动迁移，涵盖部分续传、封存源、阻塞删除、发布回滚和校验失败。单元迁移测试覆盖配额错误、中断、目标冲突及重启恢复；toast 测试覆盖启动重放、进度、阻塞连接和保留失败详情。

`test:e2e:recovery` 使用 Node 22+ 和 Chromium 验证首次协商中断、重复同时恢复、强制 SDP offer 冲突，以及重连后的摄像头、屏幕、音频 RTP。信令中断在进程内控制，SDP、ICE、解码视频帧、音频包和数据通道则使用真实浏览器传输。还验证离开、重新加入时复用本地采集，不重新打开已停止的摄像头。

`test:e2e:native-screen` 在 STUN 端点不可达时验证原生发布信令与解码 RTP：加入前后共享、双方协商角色，以及不重建房间连接的停止、重启。它用浏览器发送方替代原生主机；Windows capture crate 测试独立验证真实 libwebrtc trickle ICE 和预览帧率自适应隔离。
浏览器检查还通过解码 RTP 验证流统计路由及浮层轮询、切换生命周期。Windows 测试验证软件与 MF 编码器计数，MF 处理耗时必须来自 transform，不得来自 RTP 透传。Windows `encoding_pool::tests` 覆盖并发共享、码率拆分合并、稳定输出端口、录制所有权、实时设置和过期租约清理。
`shared_encoder_survives_viewer_churn_and_recording_owns_the_last_lease` 是明确 ignored 的硬件测试，在具有 H.264 编码器的 Windows 上加 `--ignored --nocapture --test-threads=1` 运行。它用合成帧和本地 WebRTC 接收方验证共享编码、持续解码、所有观看者离开后的录制及观看者返回。采集音频录制测试另行验证观看者退出后的音频连续性。这些检查不能证明所有 GPU 驱动表现。
可选 `late_join_headers_and_fresh_decoders` 要求 FFmpeg 和 `WEBLINK_LATE_JOIN_PROBE_DIR`，检查 AVC/HEVC 的迟到关键帧参数集及全新解码器解码，包括内存回退。AVC 还用本地 RTP 接收方检查静态启动、延迟 answer 和实时设置；HEVC 检查不证明浏览器 RTP 播放。
`static_join_timeline` 将编码器、发送方和接收方事件写入 `WEBLINK_STARTUP_PROBE_DIR`；`WEBLINK_STARTUP_LOG=1` 额外启用过滤后的 WebRTC 启动日志，定位延迟阶段。它验证直接透传启动和最早传输视频帧中的关键帧。静态加入必须同时复用采集像素及转换缓冲，关键帧需求仍受配置 FPS 上限约束。
Windows `media_self_test` 示例接受 `--scene-burst`，在自己的窗口显示移动纹理，由交换目录的 `motion` 文件控制。检查场景突变后的码率恢复时，应将原生采集与解码浏览器 RTP 一起使用；发布冒烟不测量原生编码器性能。

`test:e2e:native-screen` 也在共享屏幕旁发送合成摄像头和麦克风，再停止摄像头，确认语音与聊天继续。浏览器运行以 WebRTC 接收方替代原生适配器。Windows 桌面开发 WebView 中的 `/test/e2e/smoke/native-screen.html?single-room` 检查连接数、两条视频轨道、麦克风播放、原生 GPU 呈现和重新协商期间的二进制 SCTP。加 `&mixed` 使用浏览器发送方，`&web-viewer` 使用浏览器接收方，`&polite` 反转协商发起角色；测试窗口保持未最小化。
可选 `&fixture-window` 只采集名为 `Weblink Room Transport Test Pattern` 的窗口，并检查并发原生屏幕视频。`&web-viewer&legacy&fixture-window` 让观看方省略 `roomTransport/1`，摄像头、麦克风和数据仍应正常，主机必须打开零个屏幕发送器。

`test:e2e:playback` 使用 Node 22+、Chromium、真实视频组件与接收 RTP，检查延后附加来源、中断播放、可见性和呈现恢复、借用轨道清理，以及其他参与者加入、更新、离开期间网格和固定会议视图中的持续播放。编解码器生命周期集成覆盖每接收方格式选择、混合 H.265/H.264 观看者和延迟原生编码器退休，不能重启其他 peer。原生 PiP 返回事件由模拟产生，不证明 iPhone Safari 渲染正确。

`test:e2e:protocol` 还通过真实无序 mesh DataChannel 覆盖三个独立房间聊天协议实例，包括部分交付、连接替换和幂等重试。它通过真实 RTP 检查同时存在的合成视频源、麦克风与共享音频，再逐个移除来源，确认保留轨道不受影响。测试不模拟物理设备或 NAT。

`test:e2e:transfer` 覆盖并发私聊传输、部分下载续传，再通过真实无序控制 DataChannel 验证三个房间文件服务实例。显式下载前，offer 不能创建接收缓存或二进制通道。两个接收方独立下载，使用 SHA-256 核对完整文件的逐字节一致性。即使开启自动缓存删除，提供方房间缓存也必须在首个下载完成后保留；旧私聊 request/resume 不能绕过房间授权。检查还覆盖独立下载请求 ID、每接收方传输状态，以及不产生私聊历史投影。
文件缓存使用真实且命名空间隔离的 IndexedDB 和压缩、解压 Worker。此 fixture 的消息历史在内存中，也不渲染下载按钮；UI 交互和持久消息存储重新加载由其他测试负责。
同一冒烟还覆盖两个 peer 间共享目录获取、无二进制通道的本地内容复用、带字节比较的暂停续传、关闭双方活动通道且允许重新下载的取消、权限撤回、伪造 ID、旧请求拒绝，以及不产生新聊天消息。侧栏集成覆盖成员选择、每页 50 项、搜索排序、多选获取、刷新保留、任务取消、可见性清理和迟到响应。
房间传输 fixture 使用应用默认设置，协商 32 KiB SCTP 消息上限。完整二进制包包括七字节头都必须落在预算内，两个手动下载的接收方都须收到字节相同文件，且不能关闭聊天通道。

`test:e2e:conversations` 使用真实 IndexedDB 检查 v1 到 v2 迁移、会话隔离、标签与已读游标持久化、中断交付恢复和删除。`test:e2e:meeting` 使用本地消息仓库和合成媒体轨道渲染真实会议、聊天 UI，在此 UI 检查中替换外部信令与网络消息交付。它沿用应用高度约束和较长的房间、私聊历史，检查内部滚动、视口溢出与底部控件固定位置。
会议会话列表位于右侧面板“会话”标签页，选择私聊或房间历史会切换到聊天，不替换舞台也不离开会议。检查覆盖四标签页键盘导航、组合搜索与标签过滤、分组和窄屏面板范围。
房间对话框检查从群组标题打开设置，验证输入区不显示能力提示，并在不启动采集的前提下选择设备，包括摄像头、静音麦克风和屏幕共享已经活动的情况。设置不包含采集开关，必须保留已有轨道身份和启用状态；关闭对话框后工具栏反映这些偏好。媒体控制器测试验证下次激活时应用偏好、激活失败重试，以及丢弃过期的待处理采集结果。
设备访问检查从右侧标题直接打开设备标签页，区分未授权、已阻止和无设备，并在权限变化后刷新。授权过程停止临时轨道，从不发布它们或影响已有会议媒体。覆盖原生扬声器选择、以麦克风为基础的回退、不支持权限查询、关闭提示及销毁后迟到采集。浏览器检查使用确定性权限 API 与合成媒体，验证应用行为，不验证浏览器原生权限 UI。历史房间设置不能修改当前会议；设备 API 仍使用 fixture 与合成轨道，不验证物理硬件。
房间媒体检查立即显示发送方本地图片，传入图片在请求前仅为元数据，随后验证接收图片可加载。私聊、房间视图打开关闭真实 PhotoSwipe，并检查当前附件下载链接。媒体检查比较缩略图像素几何与 PhotoSwipe 过渡边界，验证哈希更新、前进后退，以及本地缓存恢复前挂载旧历史深链接。房间检查还在 PhotoSwipe 中解码生成的 WebM，在原生控件中播放 WAV。
文件卡片组件测试覆盖共享的 MIME 专用呈现、object URL 清理、环形进度、两种会话的暂停续传分发和每接收方房间状态，不隐式启动传输。发送方详情对话框保持大接收者列表内部滚动，打开时持续更新进度，不扩大消息气泡或发起传输。浏览器检查还比较传输前、中、后的文件卡片高度，以发现多余速度行。
焦点布局检查覆盖低高度视口和大量缩略图，仅缩略图栏滚动。网格、焦点和缩略图帧都必须保留 16:9。网格检查反复调整舞台容器而不调整窗口、增删来源、恢复侧面板，要求视频块保持在可用宽高内，列尺寸稳定且无观察器循环。单元检查覆盖列边界抖动、合并 resize 突发、每网格一个观察器、隐藏容器恢复与卸载时取消。
右侧标题的共享状态与停止操作必须适配窄视口及长演示者名称。媒体控制检查使用一个摄像头和两个共享屏幕，包括停止已固定来源并保留其他采集。屏幕选择器检查要求每个屏幕独立请求、发布可选音频，不受麦克风静音或设备变化影响。停止一个或所有屏幕必须释放相应音频。单元检查还覆盖浏览器原生停止事件、仅音频终止、无音频采集、无效采集清理和迟到权限结果。自动化中的选择器使用合成轨道，不验证原生选择器选项或操作系统音频采集。
设备选择检查使用枚举 fixture 设备及采集、输出 API stub，验证选择、约束、独立轨道和窄布局。单元检查覆盖设备替换失败、静音保留、迟到采集结果和输出路由；物理设备切换仍需实机检查。

使用 `MEETING_TEST_WIDTH=390 bun run test:e2e:meeting` 检查窄布局，设置 `MEETING_TEST_SCREENSHOT=/tmp/meeting.png` 可截取最终画面。

顺序运行所有浏览器冒烟检查：

```sh
bun run test:e2e
```

要求：

- 系统可以通过 `chromium` 启动 Chromium，或
- 设置 `CHROMIUM_PATH=/absolute/path/to/chromium`

运行器使用隔离临时配置、回环 peer 和本地 Vite，不加入已部署 Weblink 信令，也不修改真实浏览器配置。

可选环境变量：

```sh
CHAT_TEST_WIDTH=390 bun run test:e2e:chat
CHAT_TEST_REDUCED_MOTION=1 bun run test:e2e:chat
CHAT_TEST_SCREENSHOT=/tmp/chat.png bun run test:e2e:chat
CHAT_TEST_COLOR_SCHEME=dark CHAT_TEST_WIDTH=390 CHAT_TEST_SCREENSHOT=/tmp/chat-dark.png bun run test:e2e:chat
TASK_TEST_WIDTH=390 bun run test:e2e:tasks
TASK_TEST_SCREENSHOT=/tmp/tasks.png bun run test:e2e:tasks
TASK_TEST_SCREENSHOT_INFO=/tmp/client-info.png bun run test:e2e:tasks
SPEED_TEST_REPORT=/tmp/speed-report.json bun run test:e2e:speed
```

聊天冒烟会采样实际中间滚动位置，不只检查最终偏移，涵盖首次定位、批量消息到达、原生平滑滚动期间的布局变化、阅读者中断和减少动态效果偏好。还检查连续紧凑气泡、时间间隔分隔符，以及分组增长或第一条消息删除时节点稳定。可选截图使用包含文本、文件、收发气泡的隔离会话，不使用真实会话数据。

这些是本地子系统 E2E 检查，通过不代表跨设备、公网、运营商网络、后台标签页或生产部署行为已经验证。

### 浏览器基准测试 {#browser-benchmarks}

位置：`test/e2e/benchmark/`

基准测量性能，不能当作正确性通过、失败覆盖，也不应纳入普通 CI 测试套件。

运行缓存基准：

```sh
bun run bench:browser:cache
bun run bench:browser:cache --repeating
```

基准使用真实 Chromium 与 IndexedDB，有意排除 WebRTC。测量操作与存储契约见[缓存与迁移](../reference/cache-assembly.md)。

## 目录布局 {#directory-layout}

```text
test/
├── unit/                 # isolated module/contract behavior
├── integration/          # multiple Weblink modules together
├── support/              # shared fakes/helpers
└── e2e/
    ├── smoke/            # real Chromium correctness smoke tests
    └── benchmark/        # performance measurements only
```

浏览器测试环境由 `scripts/run-browser-check.mjs` 共享实现。

## 如何选择测试层 {#what-belongs-where}

选择能证明行为的最小边界：

- 解析器拒绝格式错误的 JSON → **单元测试**。
- `P2PProtocol` 通过 fake transport 完成请求 → **集成测试**。
- 对话框在 jsdom 中响应应用状态 → **集成测试**。
- Chromium 的真实 DataChannel 发送排队协议流量 → **E2E 冒烟**。
- 真实 IndexedDB VFS 完成或迁移缓存文件 → **E2E 冒烟**。
- 测量 128 MiB 缓存最终提交耗时 → **基准测试**。

不要把每个回归都升级为 E2E。优先单元、集成覆盖，只有行为依赖真实浏览器原语或 WebRTC、IndexedDB、Worker 互操作时，再增加一条浏览器冒烟路径。

## 信令后端测试 {#signaling-backend-tests}

两个 WebSocket 后端位于独立仓库，并有自己的集成套件：

- `weblink-ws-server`：Bun 测试和真实本地 WebSocket 服务器集成。
- `weblink-ws-worker`：使用 Cloudflare Workers/Durable Object 测试环境的 Vitest。

这些测试验证信令所有权、重连与缓存行为及后端限制，不属于前端仓库的浏览器 E2E 套件。

未来共享信令契约 fixture 应通过可由 CI 消费的包或规范来源分发，不依赖相邻检出路径。

## 提交前建议验证 {#recommended-validation-before-commit}

普通前端修改：

```sh
bun run lint
bun run test:unit
bun run test:integration
bun run build
```

修改涉及真实 WebRTC、IndexedDB、Worker 或仅浏览器具有的 UI 行为时，补充对应浏览器 E2E 冒烟命令。

协议或传输修改在合并前应运行针对性 E2E 冒烟。只有提出或验证性能结论时才要求基准测试。

## 自动化 {#automation}

运行 `bun run test:e2e:automation` 验证真实 Chromium DataChannel 取消及有界结果传输。报告说明已安装浏览器是否暴露 WebMCP；没有该 API 时不模拟浏览器 Agent 集成。针对性 TS 测试覆盖共享配对、连接代次、过期清理、重放、取消和设备设置批准。原生测试通过 `cargo test --locked -p weblink-desktop automation --lib` 运行，覆盖经认证的 HTTP MCP 发现、原生授权、Shell 所有权和进程清理。

### 桌面无障碍 {#desktop-accessibility}

`cargo test --locked -p weblink-desktop-accessibility` 覆盖引用所有权、读取授权撤销、过期、受保护控件、有界遍历和操作失效。在交互式 Windows 桌面运行 `cargo test --locked -p weblink-desktop-accessibility --test windows_provider -- --ignored`，会启动自有的一次性 WinForms fixture，验证真实 UIA 发现、密码脱敏、Unicode 值设置与按钮调用。SSH、服务 Session 0 无可访问的交互桌面，因此默认忽略此测试；它不操作用户已有应用窗口。
`cargo test --locked -p weblink-desktop --lib automation` 检查原生权限桥接与目录。浏览器、桌面同意流程和紧急释放仍需使用实际客户端与远程设备端到端验收。

## 设备信任 {#device-trust}

`bun run --cwd apps/web test:e2e:device-trust` 使用真实 Chromium WebRTC 检查自动首次配对、密钥持久化、变更密钥隔离、手动修复后默认权限恢复、内容撤回、媒体恢复、正常断开、通过仍存活的 peer 签发密钥自动恢复，以及不重置权限的过期续期。
`bun run --cwd apps/web test:e2e:device-trust-http` 在没有 `crypto.subtle` 或 `crypto.randomUUID` 的非安全 HTTP 源运行相同流程。运行器把测试主机名映射到回环服务器，不使用局域网设备或真实浏览器配置。
针对性身份、配对密钥与 peer 信任测试覆盖重放、DTLS 绑定、过期异步决定、仅签发方续期、确认丢失、存储失败、并发持久化、中断首次交换、原子配对提交、验证前断开或超时，以及无共同密钥时必须手动修复。信令客户端测试覆盖首次加入和恢复时的重复 ID 退避、取消，以及等待所有权释放期间的临时网络失败。

两个信令仓库都测试：原所有者继续转发时，反复出现的错误密钥、未签名和重放同 ID 加入请求，以及所有者离开后接纳重新生成的身份。运行 `bun run --cwd servers/weblink-ws-server test` 时，提供指向一次性 Redis 实例的 `WEBLINK_TEST_REDIS_URL`，可加入原子 Redis 租约与双节点信令测试。该测试不读取应用 Redis 配置。
