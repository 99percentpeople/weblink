# Changelog

All notable changes to this project will be documented in this file.

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
