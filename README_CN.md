<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/branding/weblink-logo-dark.svg" />
    <img src="public/branding/weblink-logo-light.svg" alt="Weblink" width="300" height="96" />
  </picture>

  <h3>分享更多，安装更少。</h3>

  <p>
    一个基于 WebRTC 的浏览器端 P2P 工作空间，用于文件传输、文件同步、
    聊天、剪贴板分享、屏幕共享、语音和视频。
  </p>

  <p>
    <a href="https://webl.ink"><strong>打开 Weblink</strong></a>
    ·
    <a href="docs/README.md">文档</a>
    ·
    <a href="README.md">English</a>
  </p>

  <p>
    <a href="https://github.com/99percentpeople/weblink/actions/workflows/ci.yml">
      <img src="https://github.com/99percentpeople/weblink/actions/workflows/ci.yml/badge.svg" alt="CI" />
    </a>
    <img src="https://img.shields.io/badge/WebRTC-P2P-5b5bd6" alt="WebRTC P2P" />
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  </p>
</div>

---

## 浏览器也可以成为点对点工作空间

Weblink 将文件分享与实时通信整合进一个浏览器应用。

在两台设备上打开 Weblink、加入同一个房间并建立 WebRTC 连接后，
聊天、文件、剪贴板内容和媒体数据都会通过对端之间的 WebRTC 通道传输，
而不是通过信令服务中转应用数据。

无需安装原生客户端。

## 为什么选择 Weblink？

|                                                                          |                                                                                                            |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| **⚡ WebRTC 点对点传输**<br>通过 WebRTC DataChannel 发送文件和应用数据。 | **⏯ 断点续传**<br>利用已缓存的文件分片继续未完成的传输。                                                  |
| **🔄 文件同步**<br>浏览并获取对端允许公开的缓存文件。                    | **💬 实时通信**<br>分享文字、剪贴板、语音、视频、屏幕和音频。                                              |
| **📦 浏览器本地存储**<br>使用 IndexedDB 在本地缓存已传输文件。           | **🧭 连接诊断**<br>查看 WebRTC 连接详情并进行点对点吞吐测速。                                              |
| **📱 PWA 集成**<br>安装 Weblink 后接入系统分享流程。                     | **🧩 可移植协议**<br>信令、控制、文件传输和诊断协议都具有独立的 wire contract，方便未来接入非 Web 客户端。 |

## 一个房间，多种工作流

### 文件

- 在对端之间发送文件和文件夹；
- 可选地在发送前压缩文件分片；
- 中断后继续未完成的文件传输；
- 将完成的文件保存在浏览器本地缓存；
- 搜索本地和对端公开的缓存文件；
- 在同一房间内转发或请求文件。

### 通信

- 通过 P2P 控制通道发送文字消息；
- 在已连接设备之间分享剪贴板内容；
- 共享摄像头和麦克风；
- 共享屏幕，并可附带系统音频和麦克风音频；
- 在实时会话中使用画中画和媒体控制。

### 诊断

- 查看 ICE 与连接状态；
- 查看当前 WebRTC 路由；
- 运行带版本约束的点对点吞吐测速；
- 通过统一任务视图查看传输和诊断任务状态。

## 工作原理

```mermaid
flowchart LR
    A[浏览器 A] -->|加入房间 / SDP / ICE| S[信令服务]
    B[浏览器 B] -->|加入房间 / SDP / ICE| S

    A <-->|WebRTC 数据 / 媒体| B
```

信令层负责发现客户端、管理房间成员以及完成 WebRTC 协商。
PeerConnection 建立后，应用流量通过 WebRTC 的点对点通道传输。

配置房间密码后，Weblink 可以在连接建立阶段保护信令 payload。

显示名称和头像也通过 P2P 控制协议交换，而不是作为信令 presence 公开。

## 为协议互操作而设计

Weblink 将 P2P 协议定义与浏览器 UI 实现分开维护。

目前已经明确的协议包括：

- 信令 envelope 与重连语义；
- 类型化的 P2P request/reply 控制协议；
- 文件传输 DataChannel 控制帧和二进制 packet 格式；
- 带版本号的点对点测速协议。

这样浏览器实现本身不会成为唯一的“协议规范”，也为未来的桌面端、
移动端、CLI 或原生客户端留下更清晰的接入路径。

## 在线体验

| 版本              | 信令后端                             | 地址                             |
| ----------------- | ------------------------------------ | -------------------------------- |
| **主要版本**      | Cloudflare Workers + Durable Objects | [webl.ink](https://webl.ink)     |
| **Firebase 版本** | Firebase Realtime Database           | [v.webl.ink](https://v.webl.ink) |

主要版本使用开源的
[weblink-ws-worker](https://github.com/99percentpeople/weblink-ws-worker)
作为信令后端。

使用过程中如有问题，也可以加入 QQ 群反馈：
[762463759](https://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=5MRpXPQN4vGtiLnTzCUb-NlAK9txeEoE&authKey=Gm3OmhI6g3ccmNx8rXVcPsbmEzsoBcj%2FpF%2FOlq7edcbMxTlhPLipZ6i9fwsPCsLt&noverify=0&group_code=762463759)。

## 了解更多

- [文档索引](docs/README.md)
- [架构说明](docs/ARCHITECTURE.md)
- [P2P 协议](docs/P2P_PROTOCOL.md)
- [部署说明](docs/DEPLOYMENT.md)
- [更新日志](CHANGELOG.md)

---

<div align="center">
  <strong>Weblink</strong><br />
  点对点工具，直接运行在浏览器中。
</div>
