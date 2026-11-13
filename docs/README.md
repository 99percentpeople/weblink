# 文档 / Documentation

用户文档站聚焦功能使用、设计架构、配置、常见问题和自部署。中文从[快速开始](zh/index.md)阅读，英文从 [Quick start](index.md) 阅读。

The public documentation covers using, understanding the architecture of, configuring, troubleshooting, and self-hosting Weblink. Engineering and maintenance notes remain in this repository and are excluded from the site and its search index.

## 用户指南 / User guides

| 中文                                       | English                                                    |
| ------------------------------------------ | ---------------------------------------------------------- |
| [快速开始](zh/index.md)                    | [Quick start](index.md)                                    |
| [安装与使用桌面端](zh/guide/desktop.md)    | [Desktop app](guide/desktop.md)                            |
| [房间与聊天](zh/guide/rooms.md)            | [Rooms and chat](guide/rooms.md)                           |
| [文件传输与共享](zh/guide/files.md)        | [File transfers and sharing](guide/files.md)               |
| [文件存储与管理](zh/guide/storage.md)      | [File storage and management](guide/storage.md)            |
| [音视频与录制](zh/guide/media.md)          | [Audio, video, and recording](guide/media.md)              |
| [远程桌面](zh/guide/remote-control.md)     | [Remote desktop](guide/remote-control.md)                  |
| [设备配对与权限](zh/guide/device-trust.md) | [Device pairing and permissions](guide/device-trust.md)    |
| [MCP 与自动化](zh/guide/automation.md)     | [MCP and automation](guide/automation.md)                  |
| [连接设置与测速](zh/guide/connection.md)   | [Connection settings and speed tests](guide/connection.md) |
| [常见问题](zh/guide/faq.md)                | [Troubleshooting](guide/faq.md)                            |

## 设计架构 / Architecture

| 中文                                                   | English                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| [架构概览](zh/architecture/overview.md)                | [Architecture overview](architecture/overview.md)                  |
| [信令与会话恢复](zh/architecture/signaling.md)         | [Signaling and session recovery](architecture/signaling.md)        |
| [P2P 控制协议](zh/architecture/p2p-protocol.md)        | [P2P control protocol](architecture/p2p-protocol.md)               |
| [文件传输与断点续传](zh/architecture/file-transfer.md) | [File transfer and resume](architecture/file-transfer.md)          |
| [媒体传输与录制](zh/architecture/media.md)             | [Media transport and recording](architecture/media.md)             |
| [编码、解码与 GPU 显示](zh/architecture/codecs.md)     | [Encoding, decoding, and GPU presentation](architecture/codecs.md) |
| [音频采集、编解码与播放](zh/architecture/audio.md)     | [Audio capture, codecs, and playback](architecture/audio.md)       |
| [设备身份与授权](zh/architecture/device-trust.md)      | [Device identity and authorization](architecture/device-trust.md)  |
| [存储与文件生命周期](zh/architecture/storage.md)       | [Storage and file lifecycle](architecture/storage.md)              |

## 自部署 / Self-hosting

| 中文                                    | English                                         |
| --------------------------------------- | ----------------------------------------------- |
| [自部署导读](zh/deployment/overview.md) | [Self-hosting overview](deployment/overview.md) |
| [Web 端部署](zh/deployment/hosting.md)  | [Web deployment](deployment/hosting.md)         |
| [Tauri 端部署](zh/deployment/tauri.md)  | [Tauri deployment](deployment/tauri.md)         |
| [Server 部署](zh/deployment/backend.md) | [Server deployment](deployment/backend.md)      |
| [Worker 部署](zh/deployment/worker.md)  | [Worker deployment](deployment/worker.md)       |

## 仓库内部资料 / Repository-only notes

以下资料供开发和维护使用，不发布到用户文档站。功能操作请优先阅读上面的指南。旧的顶层技术文件保留跳转入口和章节链接，方便已有仓库链接继续访问。

These notes support development and maintenance and are not published on the user site. Legacy uppercase files keep repository entry links and section targets.

| 中文                                         | English                                                          |
| -------------------------------------------- | ---------------------------------------------------------------- |
| [参与贡献](development/contributing.md)      | [Contributing](en/development/contributing.md)                   |
| [工作区开发](development/workspace.md)       | [Workspace](en/development/workspace.md)                         |
| [架构与目录](development/architecture.md)    | [Architecture](en/development/architecture.md)                   |
| [桌面实现与构建](development/desktop.md)     | [Desktop implementation and builds](en/development/desktop.md)   |
| [测试与验证](development/testing.md)         | [Testing](en/development/testing.md)                             |
| [界面动效](development/ui-motion.md)         | [UI motion](en/development/ui-motion.md)                         |
| [设备身份实现](reference/device-trust.md)    | [Device identity implementation](en/reference/device-trust.md)   |
| [自动化工具契约](reference/automation.md)    | [Automation tool contracts](en/reference/automation.md)          |
| [P2P 协议](reference/p2p-protocol.md)        | [P2P protocol](en/reference/p2p-protocol.md)                     |
| [信令协议](reference/signaling.md)           | [Signaling protocol](en/reference/signaling.md)                  |
| [文件传输协议](reference/file-transfers.md)  | [File transfer protocol](en/reference/file-transfers.md)         |
| [存储实现](reference/file-storage.md)        | [Storage implementation](en/reference/file-storage.md)           |
| [缓存迁移实现](reference/cache-assembly.md)  | [Cache migration implementation](en/reference/cache-assembly.md) |
| [录制音频补丁](reference/recording-patch.md) | [Recording audio patch](en/reference/recording-patch.md)         |
| [测速协议](reference/peer-speed-test.md)     | [Speed-test protocol](en/reference/peer-speed-test.md)           |
