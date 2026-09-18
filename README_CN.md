<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="public/branding/weblink-logo-dark.svg" />
    <img src="public/branding/weblink-logo-light.svg" alt="Weblink" width="280" height="89" />
  </picture>

  <p>
    基于 WebRTC 的浏览器端 P2P 聊天、文件传输与文件同步应用。
  </p>

  <p>
    <a href="https://github.com/99percentpeople/weblink/actions/workflows/ci.yml">
      <img src="https://github.com/99percentpeople/weblink/actions/workflows/ci.yml/badge.svg" alt="CI" />
    </a>
  </p>

  <p>
    <a href="README.md">English</a> · <strong>中文</strong>
  </p>
</div>

## 简介

Weblink 是一款基于 WebRTC 的纯网页应用，支持**文件传输**、**文件同步**以及**文字/语音/视频通信**，无需安装原生客户端，直接在现代浏览器中即可使用。

WebRTC 连接建立后，应用数据通过客户端之间的 P2P 通道直接传输。信令服务仅用于发现客户端和建立 WebRTC 连接；配置房间密码后，信令数据会使用该密码加密。

### 在线版本

| 版本          | 信令后端                             | 地址                                     |
| ------------- | ------------------------------------ | ---------------------------------------- |
| 主要版本      | Cloudflare Workers + Durable Objects | [https://webl.ink](https://webl.ink)     |
| Firebase 版本 | Firebase Realtime Database           | [https://v.webl.ink](https://v.webl.ink) |

主要版本使用 `wss://ws.webl.ink` 提供 WebSocket 信令服务，后端为运行在 Cloudflare Workers 上的 [weblink-ws-worker](https://github.com/99percentpeople/weblink-ws-worker)。

## 功能

| 功能               | 描述                                       |
| ------------------ | ------------------------------------------ |
| 🔄 **文件同步**    | 浏览并获取其他客户端缓存的文件。           |
| ⏯️ **断点续传**    | 连接中断后继续未完成的文件传输。           |
| 📂 **文件缓存**    | 使用 IndexedDB 在本地缓存传输文件。        |
| 📁 **文件夹传输**  | 自动打包、压缩并发送文件夹。               |
| 📦 **压缩传输**    | 可选择在传输前压缩文件。                   |
| ⚡ **多通道传输**  | 使用多个 WebRTC DataChannel 并行传输数据。 |
| 🔍 **文件搜索**    | 搜索本地及对端缓存的文件。                 |
| 📋 **剪贴板传输**  | 将剪贴板内容直接粘贴到聊天窗口发送。       |
| 💬 **文字聊天**    | 通过 WebRTC 交换文字消息。                 |
| 🎙️ **语音 / 视频** | 与连接的客户端共享麦克风和摄像头。         |
| 🖥️ **屏幕共享**    | 共享屏幕、系统音频及麦克风音频。           |
| 🔗 **分享与转发**  | 安装为 PWA 后使用系统分享能力发送内容。    |

更多更新请查看 [CHANGELOG.md](CHANGELOG.md)。

使用过程中如有问题，也可以加入 QQ 群反馈：[762463759](https://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=5MRpXPQN4vGtiLnTzCUb-NlAK9txeEoE&authKey=Gm3OmhI6g3ccmNx8rXVcPsbmEzsoBcj%2FpF%2FOlq7edcbMxTlhPLipZ6i9fwsPCsLt&noverify=0&group_code=762463759)。

## 快速开始

### 环境要求

- [Bun](https://bun.sh/)
- 支持 WebRTC 的现代浏览器

### 安装

```bash
git clone https://github.com/99percentpeople/weblink.git
cd weblink
bun install
```

创建 `.env.local` 并选择信令后端。

使用公网 WebSocket 信令服务：

```env
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=wss://ws.webl.ink
```

使用本地 Bun 信令服务器：

```env
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=ws://127.0.0.1:9000
```

启动开发服务器：

```bash
bun dev
```

构建生产版本：

```bash
bun run build
```

## 信令后端

Weblink 支持多种信令实现。WebRTC 连接建立后，应用消息、文件、媒体、显示名称和头像都不会通过信令服务传输。

### Cloudflare Workers

公开部署的 [webl.ink](https://webl.ink) 使用：

```text
wss://ws.webl.ink
```

信令服务由 [weblink-ws-worker](https://github.com/99percentpeople/weblink-ws-worker) 提供，运行在 Cloudflare Workers 上，并使用 Durable Objects；每个房间对应一个 Durable Object。

### 自建 WebSocket 服务

[weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server) 是基于 Bun 的 WebSocket 信令实现，适合自建部署、本地环境和局域网环境。

### Firebase

Firebase Realtime Database 仍可作为另一种信令后端。需要配置：

```env
VITE_BACKEND=FIREBASE
VITE_FIREBASE_API_KEY=your-firebase-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-firebase-auth-domain
VITE_FIREBASE_PROJECT_ID=your-firebase-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-firebase-storage-bucket
VITE_FIREBASE_MESSAGING_SENDER_ID=your-firebase-messaging-sender-id
VITE_FIREBASE_APP_ID=your-firebase-app-id
VITE_FIREBASE_DATABASE_URL=your-database-url
```

协议、隐私边界及部署说明请查看 [docs/SIGNALING.md](docs/SIGNALING.md)。

## 部署

### Docker

仓库中的 `docker-compose.yaml` 会同时构建 Weblink 前端和 [weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server)。

先修改 `docker-compose.yaml` 中的 WebSocket 地址及其他构建参数，然后运行：

```bash
docker compose up -d
```

如需启用 HTTPS，将 `server.crt` 和 `server.pem` 放入 `docker/ssl`，然后运行：

```bash
ENABLE_SSL=true docker compose up -d
```

PowerShell：

```powershell
$env:ENABLE_SSL='true'
docker compose up -d
```

也可以直接使用仓库中的 `Dockerfile` 构建和部署前端。

### Vercel 或其他静态托管平台

在托管平台中配置所需的 `VITE_*` 环境变量，并使用以下命令构建：

```bash
bun run build
```

使用公网 WebSocket 信令服务时，最小信令配置为：

```env
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=wss://ws.webl.ink
```

WebSocket 地址属于部署配置，无法在应用设置界面中由用户修改。

## STUN 和 TURN

可以通过构建环境变量配置默认 STUN 和 TURN 服务器：

```env
VITE_STUN_SERVERS=stun:stun.l.google.com,stun:stun1.l.google.com
VITE_TURN_SERVERS=turn:turn1.example.com:3478|user1|pass1|longterm,turn:turn2.example.com:5349|user2|pass2|hmac
```

当 NAT 或防火墙阻止客户端直接建立 P2P 连接时，可能需要 TURN 中继服务器。

支持的 TURN 配置格式：

```text
# coturn：用户名/密码认证
turn:turn1.example.com:3478|user1|pass1|longterm

# coturn：时间戳/HMAC 认证
turns:turn2.example.com:5349|user2|pass2|hmac

# Cloudflare TURN
name|TURN_TOKEN_ID|API_TOKEN|cloudflare
```

相关资源：

- 公共 STUN 服务器列表：[mondain/public-stun-list](https://gist.github.com/mondain/b0ec1cf5f60ae726202e)
- Cloudflare TURN：[Cloudflare Calls TURN](https://developers.cloudflare.com/calls/turn/)
- 自建 TURN：[coturn](https://github.com/coturn/coturn)

## 局域网使用

Weblink 支持在局域网内使用。请确保设备之间网络可达，并且本地防火墙没有阻止 WebRTC 流量。

如果需要完全本地化部署，可以运行 [weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server)，并在构建前将 `VITE_WEBSOCKET_URL` 指向本地信令服务器。

## 贡献

欢迎提交 Issue 或 Pull Request。

## 许可证

Weblink 基于 [MIT License](LICENSE) 开源。
