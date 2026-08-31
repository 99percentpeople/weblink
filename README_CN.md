# Weblink

[![CI](https://github.com/99percentpeople/weblink/actions/workflows/ci.yml/badge.svg)](https://github.com/99percentpeople/weblink/actions/workflows/ci.yml)

[**English Introduction**](README.md) | **中文介绍**

## 简介

Weblink 是一款基于 WebRTC 的纯网页**文件传输**和**文字/语音/视频聊天**应用，无需下载或安装，直接在浏览器中即可使用。它采用了无服务器的 P2P 架构，支持多种后端，包括 Firebase、WebSocket 通过端到端加密，保障信令消息的隐私和安全。

该项目已通过 Cloudflare Pages + Firebase 部署，请访问 [https://v.webl.ink](https://v.webl.ink)。

或者使用自建的 WebSocket 后端部署在阿里云上的 [https://webl.ink](https://webl.ink) 。

## ✨功能

Weblink 目前支持以下功能：

| **功能**          | **描述**                                                           |
| ----------------- | ------------------------------------------------------------------ |
| 🔄 **文件同步**   | 无缝检索对方缓存的文件。                                           |
| ⏯️ **续传功能**   | 如果连接中断，可轻松恢复文件传输。                                 |
| 📂 **文件缓存**   | 传输的文件会安全地缓存到 IndexedDB 中。                            |
| 🖥️ **屏幕共享**   | 支持多个客户端互相共享屏幕、摄像头和音频（包括扬声器和麦克风）。   |
| 🔍 **文件搜索**   | 快速搜索您和对方缓存的文件。                                       |
| 📋 **剪贴板传输** | 使用 `Ctrl + V` 或移动设备粘贴操作直接将剪贴板内容发送到聊天窗口。 |
| 📁 **文件夹传输** | 轻松发送文件夹，支持自动压缩。                                     |
| 📦 **压缩传输**   | 在传输文件时选择压缩功能，实现高效数据处理。                       |
| ⚡ **多通道传输** | 通过多数据通道并行传输，提高传输性能。                             |
| 🔗 **分享与转发** | 安装为 PWA 后，可通过系统分享功能发送文本或文件。                  |
| 💬 **文字聊天**   | 发送文字消息，实现流畅沟通。                                       |

更多信息请查看 [CHANGELOG](CHANGELOG.md) 了解最新更新。

如果遇到使用上的问题，欢迎加入QQ群进行提问或者反馈：[762463759 ](https://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=5MRpXPQN4vGtiLnTzCUb-NlAK9txeEoE&authKey=Gm3OmhI6g3ccmNx8rXVcPsbmEzsoBcj%2FpF%2FOlq7edcbMxTlhPLipZ6i9fwsPCsLt&noverify=0&group_code=762463759)

## 使用方法

### 本地运行（开发）

```bash
git clone https://github.com/99percentpeople/weblink.git
cd weblink
bun install
```

确保你已经在项目中配置了 Firebase 的密钥（如下所示），然后运行以下命令：

```bash
# 进行开发
bun dev
# 构建
bun build
```

### 部署到 Docker

你可以使用 `docker-compose.yaml` 将项目部署到 Docker，并且会自动构建 [weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server) 作为后端。

修改 `docker-compose.yaml` 文件以设置正确的环境变量，然后运行以下命令：

```bash
docker compose up -d
```

启用 SSL 时，需要提供 SSL 证书 `server.crt` 和密钥 `server.pem` 文件在 `docker/ssl` 目录下，然后运行以下命令：

```bash
ENABLE_SSL=true && docker compose up -d
```

```pwsh
$env:ENABLE_SSL='true' && docker compose up -d
```

你也可以使用 Dockerfile 部署到 Docker。

### 部署到 Vercel

你可以通过以下步骤将项目部署到 Vercel：

1. 前往 Vercel 网站 并登录（或创建一个账号）。
2. 连接你的 GitHub 仓库，选择你克隆的仓库。
3. 在 Vercel 项目设置中，找到 Environment Variables（环境变量），添加你的 Firebase API 密钥等环境变量（如下所示）。
4. 单击 "Deploy" 按钮，Vercel 将自动构建并部署你的项目。

### 环境变量配置 (Firebase)

在本地开发和部署到 Vercel 时，你需要配置 Firebase 的密钥。以下是需要添加的 Firebase 环境变量：

```env
VITE_FIREBASE_API_KEY
VITE_FIREBASE_AUTH_DOMAIN
VITE_FIREBASE_PROJECT_ID
VITE_FIREBASE_STORAGE_BUCKET
VITE_FIREBASE_MESSAGING_SENDER_ID
VITE_FIREBASE_APP_ID
VITE_FIREBASE_DATABASE_URL
```

### WebSocket 信令配置

无服务器部署推荐使用 [weblink-ws-worker](https://github.com/99percentpeople/weblink-ws-worker)：它运行于 Cloudflare Workers，并将每个房间映射到一个 Durable Object。基于 Bun 的 [weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server) 继续用于自建部署和回滚。

WebSocket 地址通过构建环境变量 `VITE_WEBSOCKET_URL` 固定，用户不能在设置界面中覆盖。协议边界、隐私模型、部署验证和回滚流程请参阅[信令服务文档](docs/SIGNALING.md)。

### Vercel 环境变量配置

部署到 Vercel 时，请按照以下步骤设置环境变量：

1. 打开你的 Vercel 项目，进入 "Settings"。

2. 找到 Environment Variables。

3. 分别添加上述 Firebase 配置项，将对应的值填入字段中。

### 本地环境变量 (.env.local)

在本地开发时，创建一个 .env.local 文件，将 后端选择 FIREBASE、WEBSOCKET

```env
# 后端选择 FIREBASE、WEBSOCKET

# FIREBASE 配置
VITE_BACKEND=FIREBASE
VITE_FIREBASE_API_KEY=your-firebase-api-key
VITE_FIREBASE_AUTH_DOMAIN=your-firebase-auth-domain
VITE_FIREBASE_PROJECT_ID=your-firebase-project-id
VITE_FIREBASE_STORAGE_BUCKET=your-firebase-storage-bucket
VITE_FIREBASE_MESSAGING_SENDER_ID=your-firebase-messaging-sender-id
VITE_FIREBASE_APP_ID=your-firebase-app-id
VITE_FIREBASE_DATABASE_URL=your-database-url

# WEBSOCKET 配置
VITE_BACKEND=WEBSOCKET
VITE_WEBSOCKET_URL=wss://ws.webl.ink
```

## 注意事项

### STUN 和 TURN 服务器配置

你可以给应用配置多个默认的 STUN 和 TURN 服务器，用户使用时不需要手动配置，在.env.local 文件中配置方式如下：

```env
#  多个 STUN 和 TURN 服务器，用逗号分隔
VITE_STUN_SERVERS=stun:stun.l.google.com,stun:stun1.l.google.com
VITE_TURN_SERVERS=turn:turn1.example.com:3478|user1|pass1|longterm,turn:turn2.example.com:5349|user2|pass2|hmac
```

如果你在非局域网（NAT 环境）下使用 P2P 连接，可能需要配置 TURN 服务器以确保能够建立连接。在设置页面中，你可以根据以下格式配置 TURN 服务器，支持 coturn 和 Cloudflare 提供的 TURN 服务，配置项之间用换行符分隔：

**TURN 配置格式**：

```plaintext
# coturn 使用账号密码进行验证
turn:turn1.example.com:3478|user1|pass1|longterm
# coturn 使用时间戳进行验证
turns:turn2.example.com:5349|user2|pass2|hmac
# 使用 Cloudflare 提供的 TURN 服务器
name|TURN_TOKEN_ID|API_TOKEN|cloudflare
```

以下为一些公共 STUN 和 TURN 服务器的获取方法：

#### 公共 STUN 服务器

此应用默认使用 Google 的 STUN 服务器，如果无法连接，请自行配置 STUN 服务器。可以参考 [https://gist.github.com/mondain/b0ec1cf5f60ae726202e](https://gist.github.com/mondain/b0ec1cf5f60ae726202e) 获取公共 STUN 服务器列表。然后在设置页面中添加 STUN 服务器，格式为 `stun:xxxx:xxxx`。例如： `stun:stun.l.google.com:19302`。

#### Cloudflare Calls TURN 服务器

可以使用 Cloudflare Calls 提供的 TURN 服务器，请访问 [https://developers.cloudflare.com/calls/turn](https://developers.cloudflare.com/calls/turn)。然后在设置页面中添加 TURN 服务器，格式为 `name|TURN_TOKEN_ID|API_TOKEN|cloudflare`。

#### 自建 TURN 服务器

可以参考 [https://github.com/coturn/coturn](https://github.com/coturn/coturn) 自建 TURN 服务器。

### 局域网内使用

应用目前支持在非安全环境下局域网内使用，局域网内使用时，请确保你的设备在同一个局域网内，并且防火墙没有阻止 P2P 连接。

并同时运行 [weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server) 以支持 WEBSOCKET 连接。

## 贡献

欢迎贡献代码！请随时提交问题或拉取请求。

## 许可证

该项目基于 [MIT License](LICENSE) 开源。
