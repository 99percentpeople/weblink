# Changelog

All notable changes to this project will be documented in this file.

## [1.1.0] - 2026-10-06

Weblink 1.1 adds native Windows screen sharing and remote control, with mobile
input, clipboard and file exchange, and improved desktop and room management.
Weblink 1.1 新增 Windows 原生屏幕共享与远程控制，支持移动端输入、剪贴板和文件交换，并完善桌面端体验与房间管理。

### Major Changes

- Add native Windows display and window sharing with source previews, DXGI/WGC capture, system audio on supported systems, and available software encoders or H.264/HEVC hardware encoding 新增 Windows 原生显示器与窗口共享，支持来源预览、DXGI/WGC 采集、受支持系统上的系统音频，以及可用的软件编码器或 H.264/HEVC 硬件编码
- Add remote mouse and keyboard control of Windows display shares from browser and desktop clients, with local approval, remembered allow/deny rules, screen requests, synchronized cursor appearance, and customizable input-release and emergency-revocation shortcuts 新增浏览器与桌面客户端对 Windows 显示器共享的远程鼠标和键盘控制，支持本机授权、记住允许或拒绝规则、请求共享屏幕、同步光标外观，以及自定义输入释放和紧急撤销快捷键
- Add mobile trackpad and direct-touch control, configurable gestures and sampling, soft-keyboard and IME input, and optional keyboard visibility following the remote text field 新增移动端触控板与直接触摸控制，支持可配置手势和采样率、软键盘与输入法输入，以及按远端文本框焦点自动显示或隐藏键盘
- Add opt-in remote clipboard synchronization for text, rich text, images and files, with browser capability checks, file copies to the clipboard or local library, ZIP conversion for folders, and cancellable file-transfer progress 新增可选的远程剪贴板同步，支持文本、富文本、图片与文件，按浏览器能力启用，将复制的文件写入剪贴板或本机文件库，将文件夹转换为 ZIP，并显示可取消的文件传输进度
- Add opt-in file drag-and-drop onto controlled Windows screens, copying local files into compatible remote applications; share a configurable per-operation file limit with clipboard transfers, defaulting to 64 MiB and supporting up to 512 MiB 新增可选的远程文件拖放，将本地文件拖入受控 Windows 画面中的兼容应用；与剪贴板文件传输共用单次大小限制，默认 64 MiB，最高可设为 512 MiB

### Improvements

- Show both the shared Web application version and desktop package version in desktop About and copied version information 桌面端“关于”及复制的版本信息同时显示共用 Web 应用版本和桌面程序版本
- Expand desktop window behavior with tray controls, configurable close actions, launch-at-login preferences, optional hiding after control approval, and a resizable always-on-top native picture-in-picture mode that preserves the meeting and control session 完善桌面端窗口行为，新增托盘操作、可配置关闭行为、开机启动设置、批准远程控制后自动隐藏选项，以及保留会议和控制会话的可缩放置顶原生画中画模式
- Unify browser and Windows notifications for messages, control requests, speed-test requests and completed transfers, with configurable previews and sound; Windows notifications support inline replies and request approval 统一浏览器与 Windows 的消息、远程控制请求、测速请求及传输完成通知，支持配置内容预览和声音；Windows 通知支持直接回复与批准请求
- Add recent-room selection with saved connection details, unify client and room permission management, and order conversations and permission records by persisted activity; move automatic-download size limits into shared transfer settings while preserving per-room switches 新增保存连接信息的最近房间选择，统一客户端与房间权限管理，按持久化活动时间排列会话和权限记录；将自动下载大小限制移至统一传输设置，并保留各房间的独立开关
- Expand media settings with live resolution, frame-rate and bitrate changes, display-derived high-refresh options, audio codec/sample-rate/channel controls, SDR color settings, and per-stream diagnostics 完善媒体设置，支持实时调整分辨率、帧率与码率，按显示器刷新率提供高帧率选项，并新增音频编码、采样率、声道、SDR 色彩设置及各路媒体诊断信息
- Reduce background work by generating source previews on demand, pausing hidden previews and diagnostics, and waking native workers on events while preserving active sharing and control; reduce desktop package size 减少后台资源占用，按需生成来源预览、暂停隐藏画面的预览和诊断，并按事件唤醒原生工作线程，同时保持共享和控制会话；缩减桌面程序体积
- Unify settings controls and dialog layouts, improve keyboard focus behavior, and refine meeting-tile actions for mouse hover, touch and fullscreen use 统一设置控件与弹窗布局，改善键盘焦点行为，并优化画面操作按钮在鼠标悬停、触摸及全屏场景下的使用体验

### Fixes

- Restore password-protected room interoperability over LAN HTTP with a shared PBKDF2/AES-GCM implementation when Web Crypto is unavailable, and reject joining if password preparation fails 修复局域网 HTTP 下密码房间的互通问题，在 Web Crypto 不可用时使用一致的 PBKDF2/AES-GCM 实现，并在密码准备失败时中止加入房间
- Fix desktop resume deadlocks, stale startup paths and native sharing recovery; improve remote-control recovery after transient congestion or connection interruptions and release stale held input 修复桌面端恢复窗口时的死锁、失效的启动路径及原生共享恢复问题；改进短暂拥塞或连接中断后的远程控制恢复，并释放残留按键与触点
- Fix stalled file retries by deduplicating retransmitted blocks, clearing failed decoding state and ignoring late results after a transfer is paused 修复文件重试卡住的问题，对重传区块去重、清理失败的解码状态，并忽略传输暂停后迟到的处理结果
- Correct native stream color metadata, duplicate encoder choices, picture-in-picture restoration and fullscreen overlays; keep request approval actions usable while dialogs are open 修正原生媒体流的色彩元数据、重复编码器选项、画中画恢复及全屏浮层问题，并保证弹窗打开时仍可操作请求审批按钮

### Compatibility Notes

- Native hosting features target Windows; browser clients can control supported Windows display shares, while window shares remain view-only. Remote input requires host approval or an existing allow rule 原生被控功能面向 Windows；浏览器客户端可控制受支持的 Windows 显示器共享，窗口共享仅支持观看。远程输入需要被控端批准或已有允许规则
- HEVC requires a compatible host hardware encoder and a receiver exposing H.265 support in WebRTC. Native screen streaming remains 8-bit SDR YUV 4:2:0 HEVC 需要兼容的被控端硬件编码器，以及在 WebRTC 中提供 H.265 支持的接收端。原生屏幕传输仍采用 8 位 SDR YUV 4:2:0
- Self-hosted signaling servers must return the version 2 join acknowledgment; a missing acknowledgment now fails joining after ten seconds instead of treating an open socket as successful room membership 自部署信令服务必须返回 v2 入房确认；未收到确认时将在十秒后判定加入失败，不再将 WebSocket 已连接视为成功入房

### Infrastructure

- Separate web and desktop development/production workflows behind shared checks, reuse desktop build outputs, and produce Windows NSIS installer artifacts for stable release tags 将 Web 与桌面端的开发及正式构建拆分为依赖统一检查的工作流，复用桌面构建产物，并为正式版本 tag 生成 Windows NSIS 安装包产物
- Read public WebSocket/STUN build settings from GitHub Environment variables for both web and desktop builds; replace the former `PAGES_BUILD_ENV` secret with `VITE_WEBSOCKET_URL` and `WEBLINK_STUN_SERVERS` variables Web 与桌面构建统一从 GitHub Environment variables 读取公开的 WebSocket/STUN 配置，以 `VITE_WEBSOCKET_URL` 和 `WEBLINK_STUN_SERVERS` 变量替代原有 `PAGES_BUILD_ENV` secret

## [1.0.7] - 2026-09-29

### Improvements

- Add the first Tauri desktop shell and shared platform abstraction, including Windows build automation, desktop-specific runtime handling, and packaged application assets 新增首个 Tauri 桌面端外壳与共享平台抽象，包括 Windows 构建流程、桌面运行时处理及应用打包资源
- Add native capture diagnostics and development tooling for the desktop app, with Windows capture backend probes, synchronized workspace tooling, configuration UI, and automated tests 新增桌面端原生采集诊断与开发工具，包括 Windows 采集后端探测、workspace 同步工具、配置界面及自动化测试
- Centralize conversation message persistence behind a shared repository contract so browser storage, chat history, delivery state, and transfer-related message updates follow one persistence path 将会话消息持久化统一到共享 repository 契约，使浏览器存储、聊天历史、送达状态及传输相关消息更新走同一持久化路径
- Add real-browser persistence and private-messaging regression checks to CI to cover IndexedDB and WebRTC messaging behavior that unit tests cannot fully reproduce 在 CI 中加入真实浏览器的持久化与私聊回归检查，覆盖单元测试难以完整复现的 IndexedDB 与 WebRTC 消息行为

### Fixes

- Persist private messages correctly after joining a room and keep conversation history available when room membership changes 修复加入房间后私聊消息未正确持久化的问题，并在房间成员状态变化时保持会话历史可用
- Guard browser messaging and persistence against stale, deleted, or mismatched records so retired asynchronous writes cannot recreate removed messages or corrupt active conversations 加强浏览器消息与持久化边界，避免过期、已删除或不匹配的记录通过异步写入重新生成消息或影响当前会话

## [1.0.6] - 2026-09-27

### Improvements

- Load managed TURN credentials from the signaling service instead of embedding managed TURN secrets in the web build, while preserving user-configured STUN and additional TURN servers 改为从信令服务获取托管 TURN 临时凭据，不再将托管 TURN 密钥嵌入前端构建，同时保留用户自定义 STUN 与额外 TURN 服务器
- Separate meeting audio sources from video presentation and simplify the media protocol so microphone, screen audio, and other remote audio sources are tracked and rendered independently 将会议音频源与视频展示分离，并简化媒体协议，使麦克风、屏幕音频及其他远端音频源可独立跟踪和播放
- Unify private and room conversation messaging around shared submission, delivery, retry, draft, and projection services for more consistent chat behavior 统一私聊与群聊的消息提交、送达、重试、草稿和投影服务，使不同会话的聊天行为保持一致
- Unify file drag-and-drop imports across chat, shared files, and the local library, including shared import handling and consistent drop feedback 统一聊天、共享文件及本地文件库的拖放导入流程，共用导入处理并保持一致的拖放反馈
- Refine toast presentation with dedicated icons and styling for clearer application feedback 优化 Toast 的图标与样式，使应用反馈更清晰

### Infrastructure

- Reorganize Weblink as a workspace with the web app under `apps/web` and signaling implementations tracked as server submodules 将 Weblink 重组为 workspace，Web 前端迁移至 `apps/web`，并以 server submodule 管理信令实现
- Unify workspace dependency installation, local development commands, CI paths, Docker builds, and deployment documentation around the new repository layout 统一新仓库结构下的依赖安装、本地开发命令、CI 路径、Docker 构建及部署文档

## [1.0.5] - 2026-09-25

### Improvements

- Rework meeting panel navigation around routed sidebar state, shared-file views, and stable wide-panel behavior so chat, files, people, and room information transition consistently 重构会议侧栏路由状态、共享文件视图及宽面板状态，使聊天、文件、成员和房间信息之间的切换保持一致
- Refine meeting source presentation, picture-in-picture behavior, responsive media layouts, and layout transitions while preserving scroll position during size and route changes 优化会议画面呈现、画中画、响应式媒体布局及布局过渡，并在尺寸和路由变化时保持滚动位置
- Unify private and room conversation history rendering, stabilize chat composer auto-resize, and present file-transfer progress consistently across messages and the task list 统一私聊和群聊的历史消息窗口，稳定聊天输入框自动尺寸调整，并统一消息与任务列表中的文件传输进度显示
- Simplify peer negotiation and connection ownership, move recovery to signaling-driven peer-online events, and retain peer profile information while connections are being restored 简化 P2P 协商与连接所有权，以信令驱动的 peer-online 事件恢复连接，并在重连过程中保留对端资料

### Fixes

- Restore Safari file-transfer compatibility, including safer abort handling and cache merging during transfer completion 恢复 Safari 文件传输兼容性，包括更可靠的取消处理和传输完成时的缓存合并
- Stabilize file drag-and-drop state across nested controls and prevent stale forbidden-drop state from remaining after leaving the target area 稳定嵌套控件中的文件拖放状态，避免离开不可拖放区域后错误状态残留
- Prevent message galleries and media previews from reopening after close animations, and cancel interrupted native layout animations safely 修复消息图片预览和媒体预览在关闭动画后再次打开的问题，并安全处理被中断的原生布局动画
- Improve reconnect behavior, connection logging, and session replacement so stale asynchronous work cannot disrupt the active peer connection 改进重连、连接日志及会话替换流程，避免过期异步任务影响当前有效的 P2P 连接

### Compatibility Notes

- Remove Firebase signaling support and keep WebSocket signaling as the single supported signaling path 移除 Firebase 信令支持，仅保留 WebSocket 作为统一信令通道
- Remove the unreliable chat capture action from the composer 移除稳定性不足的聊天拍照入口

### Infrastructure

- Add continuously deployed development builds at `dev.webl.ink`, gate development and production deployments on the shared CI checks, and simplify Cloudflare Pages production deployment 新增持续部署到 `dev.webl.ink` 的开发构建，让开发及正式部署统一依赖 CI 检查，并简化 Cloudflare Pages 正式部署流程
- Pass `VITE_TURN_SERVERS` through Docker builds and keep development/production Pages builds supplied through their environment-specific build configuration Docker 构建支持传入 `VITE_TURN_SERVERS`，开发及正式 Pages 构建继续通过各自环境配置注入前端构建变量

## [1.0.4] - 2026-09-24

### Improvements

- Expand file drag-and-drop to the full private and room chat surface, add room file uploads, and keep the drop overlay minimal with a stable fade transition 将文件拖放范围扩展到整个私聊和群聊界面，新增群聊文件上传，并以稳定的淡入淡出保持拖放提示简洁
- Pre-bundle `hash-wasm` and `fflate` during Vite development startup and isolate browser smoke-test dependency caches to avoid invalidating the active development server 在 Vite 开发启动时预构建 `hash-wasm` 与 `fflate`，并隔离浏览器冒烟测试的依赖缓存，避免使正在运行的开发服务器缓存失效

### Fixes

- Snapshot nested reactive file metadata before IndexedDB writes so Solid store proxies cannot trigger `DataCloneError` when caching fingerprints, aliases, content records, or references 在写入 IndexedDB 前快照嵌套的响应式文件元数据，避免 Solid store 代理在缓存指纹、别名、内容记录或引用时触发 `DataCloneError`
- Make fingerprint worker failures actionable, preserve native worker errors and source locations, handle deserialization failures, and allow retries with a fresh worker 改进文件指纹 Worker 错误处理，保留原始异常与脚本位置，处理反序列化失败，并允许使用新的 Worker 重试
- Stabilize drag enter/leave handling across nested chat elements so the upload background and native drag cursor no longer flicker when moving through the interface 稳定嵌套聊天元素间的拖入拖出状态，避免拖动文件经过界面时上传背景和原生拖拽光标反复闪动

## [1.0.3] - 2026-09-24

### Improvements

- Keep local camera, microphone, and screen capture running when leaving a room, and reuse live tracks when rejoining without reopening sources that were explicitly stopped 离开房间时保留本地摄像头、麦克风及屏幕采集，重新加入时复用仍在运行的轨道，不重新打开已明确停止的来源
- Keep the Join room and Edit room actions together in the local preview notice 优化本地预览提示中的按钮排列，让“加入房间”和“编辑房间”保持成组显示

### Fixes

- Restore room and peer connections after temporary signaling interruptions, publish socket readiness before replaying membership events, and discard stale sessions after server resume expiry 修复短暂信令断开后的房间与成员连接恢复，在回放成员事件前更新连接状态，并在服务端会话恢复失效后清理旧会话
- Resolve simultaneous reconnect negotiation collisions and restore camera, screen, audio, and messaging channels while preventing retired asynchronous work from disconnecting a replacement connection 修复双方同时重连时的协商冲突，恢复摄像头、屏幕、声音和消息通道，避免旧异步任务破坏新连接
- Defer initial video attachment until the meeting view is visible, and refresh inline playback after visibility, native picture-in-picture, fullscreen, or decoded-size changes without replacing the received stream 将视频首次绑定延后到会议画面可见时，并在可见性、原生画中画、全屏或解码尺寸变化后恢复页面内播放，保留原接收流

### Compatibility Notes

- iPhone Safari device verification remains pending; the inline-playback changes target the reported case where screen sharing plays in native picture-in-picture but appears black in the page iPhone Safari 真机验证仍待完成；本次页面内播放修复针对屏幕共享在原生画中画中正常、但在页面中黑屏的反馈

## [1.0.2] - 2026-09-24

### Improvements

- Automatically restore a waiting tab's room connection when the active tab closes or leaves; allow only one waiting tab to reconnect while preserving explicit takeover and keeping stopped capture devices off 当前使用的标签页关闭或退出房间后，自动恢复等待页面的房间连接；多个页面等待时只恢复一个，保留手动接管操作，已停止的采集设备保持关闭
- Automatically feature a mobile video after native picture-in-picture entry succeeds, using the existing layout transition and retaining its selection on exit 移动端视频成功进入独立画中画后，自动切换为主画面并沿用现有过渡，退出画中画后保留主画面选择
- Hide layout switching and pin controls when there is only one rendered source; use a single-row icon-and-label layout for mobile sidebar tabs and refine unread badge spacing 仅有一个画面时隐藏布局切换及固定按钮，移动端侧栏 tab 的图标与文字改为单行显示，并调整未读标记间距

### Fixes

- Recover paused live-video playback when the first frame becomes ready, a received track resumes, or the video becomes visible again, without replacing the received stream or stopping its tracks 在首帧就绪、接收轨道恢复或画面重新可见时恢复已暂停的视频播放，保留原接收流及轨道
- Distinguish autoplay denial from generic video errors and retain a translated Play video action for manual recovery, with Simplified Chinese, Traditional Chinese, and English messages 区分自动播放被拦截与普通视频错误，保留可手动恢复的“播放画面”操作，并补齐简体中文、繁体中文和英文提示

### Compatibility Notes

- iPhone Safari device verification remains pending; the reported black screen on initial screen-share reception is not yet confirmed resolved iPhone Safari 真机验证仍待完成，尚未确认已解决反馈中的首次接收屏幕共享黑屏问题

## [1.0.1] - 2026-09-24

### Improvements

- Add independent native video picture-in-picture controls to supported videos in the mobile layout, with an in-place notice and restore action; retain document picture-in-picture as a separate meeting feature 在移动端布局中为支持的视频添加独立画中画按钮，进入后显示原位提示及恢复操作，文档画中画继续作为独立会议功能
- Request landscape or portrait orientation from the actual video aspect ratio in fullscreen, follow video rotation, and release the orientation lock on exit when the browser supports it 全屏时根据实际画面比例请求横屏或竖屏，跟随视频方向变化，并在退出时释放浏览器支持的方向锁定
- Detect screen-sharing and picture-in-picture capabilities from available APIs and localize browser error feedback 根据实际 API 检测屏幕共享与画中画能力，并本地化浏览器错误提示

### Fixes

- Fix mobile page height overflow when browser address bars or the keyboard change the visible viewport 修复移动端浏览器地址栏或键盘改变可视区域时的页面高度溢出
- Prevent repeated WebSocket reconnects caused by competing tabs for the same room identity; show a full-page notice with an explicit switch-to-this-page action that releases the previous page's meeting and capture resources 修复相同房间身份在多个标签页之间争抢连接导致的反复重连，新增整页提示及“切换到此页面”操作，并释放原页面的会议与采集资源
- Correct signaling socket replacement order and recheck connection state after asynchronous encryption to avoid sending through a closed socket 修正信令连接替换顺序，并在异步加密后重新检查连接状态，避免向已关闭的 WebSocket 发送数据

## [1.0.0] - 2026-09-24

Weblink 1.0 is a major update with a complete interface redesign, online group
chat, and a shared file library. Weblink 1.0 是一次重大更新，带来完整界面重构、在线群组聊天和共享文件库。

### Major Changes

- Completely redesign the interface around a unified meeting workspace, with chat, members, shared files, and live room information in a responsive sidebar; open the file library, settings, and transfer tasks in dialogs without leaving the meeting 完整重构界面，以统一会议工作区为中心，通过响应式侧栏查看聊天、成员、共享文件及在线房间信息，并在弹窗中管理文件库、设置和传输任务
- Add online room group chat alongside private conversations, including text, file attachments, forwarding, per-member delivery status, and locally stored history 新增在线房间群组聊天，与私聊并行使用，支持文字、文件附件、转发、成员送达状态及本机历史记录
- Introduce a content-deduplicated local file library and one shared file list across rooms; browse a member's shared files with search, sorting, pagination, previews, and batch downloads 新增按内容去重的本机文件库及跨房间共用的共享清单，支持浏览成员共享文件、搜索、排序、分页、预览及批量获取
- Add explicit sharing controls, file and folder imports, and automatic sharing for newly sent files; shared content remains available independently of chat history 新增共享开关、文件及文件夹导入，新发送的文件自动开启共享，共享内容独立于聊天记录保留
- Fetch shared files directly into the local library and task list without creating chat messages; support progress, pause, resume, cancellation, and reuse of already available content 获取共享文件直接进入本机文件库和任务列表，不产生聊天消息，支持进度、暂停、继续、取消及复用已有内容

### Improvements

- Refine meeting layouts, screen sharing, picture-in-picture, sidebar transitions, and mobile resizing behavior 优化会议布局、屏幕共享、画中画、侧栏过渡及移动端尺寸切换
- Add member shortcuts for private chat and temporary audio muting, plus room-wide control of locally received audio 新增成员私聊与临时静音快捷操作，并支持统一控制本机接收的房间声音
- Separate microphone, speaker, and camera permission controls; improve device discovery, default-output behavior, and permission feedback across browsers 分离麦克风、扬声器与摄像头权限控制，改善跨浏览器设备发现、默认输出及授权反馈
- Unify empty chat states and user-facing error messages, complete translations, and improve file selection and preview behavior 统一聊天空状态与用户可见错误提示，补全翻译，并优化文件选择及预览体验

### Upgrade Notes

- Room messages are delivered to currently connected members; history remains in each browser, with no server-side message or file storage 房间消息仅发送给当前在线成员，历史记录保存在各自浏览器，服务器不保存聊天消息或文件
- Existing cached files stay private after upgrading; importing or receiving a file does not automatically share it 升级前已有缓存默认不共享，仅导入或接收文件不会自动开启共享
- Shared directories expose only complete, explicitly shared content; access is checked again when fetching, and peers must support the shared-file protocol 共享目录仅展示完整且已开启共享的内容，获取时会再次校验权限，双方需支持共享文件协议

### Privacy

- Remove names and avatars from signaling presence entirely; exchange profile metadata only through WebRTC 信令在线信息完全移除名称和头像，个人资料仅通过 WebRTC 交换

### Infrastructure

- Add a GitHub Actions workflow for Cloudflare Pages deployments from stable version tags, with version checks, tests, and production builds before upload 新增基于正式版本 tag 的 Cloudflare Pages 部署工作流，上传前执行版本校验、测试及生产构建
- Document the Cloudflare Durable Object signaling service, fixed deployment endpoint, validation, and rollback workflow 补充 Cloudflare Durable Object 信令服务、固定部署地址、验证及回滚流程文档

## [0.13.0] - 2026-08-31

### Privacy

- Exchange display names and avatars through the WebRTC DataChannel while signaling publishes only anonymous presence metadata 通过 WebRTC DataChannel 交换显示名称和头像，信令仅发布匿名在线元数据

## [0.12.0] - 2026-02-05

### Refactors

- Refactor file transfer into FileSender/FileReceiver and manage via transfer-service 拆分文件传输为 FileSender/FileReceiver 并由 transfer-service 统一管理

- Replace WebRTCContext with AppStateContext and unify session/message/cache state 用 AppStateContext 替换 WebRTCContext 并统一管理会话/消息/缓存等状态

- Introduce RTC protocol layer (rtc-service + rtc-protocol) with ACK/dedup/timeout and add tests 引入 RTC 协议层（rtc-service + rtc-protocol）实现 ACK/去重/超时，并补充测试

### Improvements

- Outbound messaging now uses protocol request with unified error handling 发送消息统一走协议层 request 并统一错误处理

### Fixes

- Fix resumed transfer initial speed spike on sender side 修复发送端断点续传初始速度异常偏大的问题

### Chores

- Switch package manager to Bun (add bun.lock, remove pnpm-lock) 切换包管理器到 Bun（新增 bun.lock，移除 pnpm-lock）

## [0.11.4] - 2025-12-30

### New Features

- Add manual settings for preferred encoder 添加手动设置首选编码器

## [0.11.3] - 2025-08-29

### New Features

- Add camera capture button in chat bar 添加聊天栏的摄像头捕获按钮

### Fixes

- Fix some UI issues 修复部分 UI 问题

## [0.11.2] - 2025-03-17

### Improvements

- Improve the video loading experience 改善视频加载体验

## [0.11.1] - 2025-02-05

### New Features

- Add grid layout, support drag and resize 添加网格布局，支持拖动和调整大小

- Add pause file transfer feature 添加暂停文件传输功能

## [0.10.6] - 2025-01-26

### New Features

- Add video constraints modification 添加视频约束修改功能

### Bug Fixes

- Fix the video max bitrate not working 修复了视频最大比特率不工作的问题

## [0.10.5] - 2025-01-14

### Bug Fixes

- Fix the bug that the remote stream cannot be removed correctly 修复了远程流无法正确更新的问题

## [0.10.4] - 2025-01-05

### Improvements

- Improve the encryption performance when using crypto-js 优化使用 crypto-js 时的加密性能

## [0.10.3] - 2024-12-14

### New Features

- Screen Sharing: Add volume indicator 屏幕共享添加音量指示器

- Screen Sharing: Add Mute button 屏幕共享添加静音按钮

- Screen Sharing: Add media selection dialog 屏幕共享添加媒体选择对话框

- Screen Sharing: Add media constraints control 屏幕共享添加媒体约束控制

- Screen Sharing: Add global audio player 屏幕共享添加全局音频播放器

- Screen Sharing: Add fullscreen and pip mode 屏幕共享添加全屏和画中画模式

## [0.9.2] - 2024-12-09

### New Features

- Add starter message 添加开始指引

### Improvements

- Improve the UI of the client page 优化客户端页面 UI

- Improve the video message UI 优化视频消息 UI

## [0.8.0] - 2024-11-29

### New Features

- Add share file feature 添加分享文件功能

### Improvements

- Improve the connection stability 改善连接稳定性

- Automatically try to reconnect when the connection is lost 自动尝试重新连接

## [0.7.5] - 2024-11-26

### New Features

- Add progress display in file list 在文件列表中添加进度显示

- Add double click to preview file in file table, and request file when status is not_started or stopped in sync page 在文件表中添加双击预览文件功能，当状态为 not_started 或 stopped 时在同步页面请求文件

### Improvements

- Improve the input label style 优化输入标签样式

- Improve the file table status display 优化文件表的状态显示

- Improve the file processing function, now can abort the file processing 优化文件处理功能，现在可以中止文件处理

- Improve the chat interface for loading more message on scroll 优化消息滚动加载的聊天界面

### Bug Fixes

- Fix the bug that check ice server availability works incorrectly 修复了检查 ICE 服务器可用性不正确的问题

- Fix the bug that the file transfer status is displayed incorrectly when starting 修复了文件传输状态在开始时显示不正确的问题

## [0.6.5] - 2024-11-14

### New Features

- Add file sync feature, now you can get the files cached by the peer 添加文件同步功能，现在可以获取对方缓存的文件

- Add strong password generation function 添加强密码生成功能

### Improvements

- Improve the file search function 优化文件搜索功能

- Using crypto-js for encryption in non-secure contexts 在非安全上下文中使用 crypto-js 进行加密

- Add sender resume file feature 添加发送端恢复传输功能

- Improve the UI of sending message 优化消息的 UI

### Bug Fixes

- Fix the bug that the file chunk cannot be received when resuming 修复了续传时文件区块接收的问题

- Fix the bug that messageChannel is undefined 修复了 messageChannel 未定义的问题

## [0.5.0] - 2024-11-04

### New Features

- Add Share Target API support, you can share files to Weblink from other apps 添加 Share Target API 支持，可以从其他应用分享文件到 Weblink

- Add forward menu option in file table 在文件表中添加转发菜单选项

### Bug Fixes

- Fix some i18n issues 修复一些 i18n 问题

## [0.4.1] - 2024-11-03

### New Features

- Add redirect option after connection in client menu 在客户端菜单中添加连接后重定向选项

- QR code dialog now displays your name 二维码对话框现在会显示自己的用户名

### Improvements

- Move the file chunk merge process to Web Worker to improve performance 将文件区块合并流程转移到 Web Worker 中提高性能

## [0.4.0] - 2024-11-01

### New Features

- Add folder transfer feature 添加文件夹传输功能

### Improvements

- Use Web Worker to compress and uncompress files 使用 Web Worker 压缩和解压缩文件

## [0.3.3] - 2024-10-31

### Bug Fixes

- Fix the bug that the message cannot be scrolled to the bottom when the client is online 修复了当客户端在线时消息无法滚动到底部的问题

### Improvements

- Improve the animation of the message 优化消息的动画

- Improve the date format 优化日期格式

## [0.3.2] - 2024-10-30

### New Features

- Add clipboard history dialog 添加剪贴板历史对话框

## [0.3.1] - 2024-10-29

### Bug Fixes

- Fix the bug that the application cannot be used in a non-secure context 解决了应用在非安全上下文无法使用的问题

## [0.3.0] - 2024-10-28

### New Features

- Add clipboard paste feature 添加剪贴板粘贴功能
