# Web 端部署

本指南用于在自己的服务器或托管平台运行 Weblink。前端提供网页界面，后端负责设备发现和连接协商；消息、文件和媒体通过 WebRTC 在设备之间传输。

自行托管前端是可选项。如果只想通过现有网页或桌面端连接自己的信令服务，先看[自部署导读](overview.md#signaling-only)。

| 部署方式               | 操作顺序                                                                         |
| ---------------------- | -------------------------------------------------------------------------------- |
| 同一台服务器运行前后端 | 直接按本文的 [Docker Compose](#docker) 步骤操作                                  |
| 前后端分别部署         | 先完成[Server 部署](backend.md)或 [Worker 部署](worker.md)，再配置和构建静态前端 |

示例域名和 `192.168.1.20` 都需要替换为自己的地址。除非特别说明，本文命令均在仓库根目录执行。

本文部署浏览器访问的 Web 前端。桌面安装包的配置、构建和安装见 [Tauri 端部署](tauri.md)。

## 准备环境与源码 {#requirements}

安装 Git，获取包含后端的完整源码：

```sh
git clone --recurse-submodules https://github.com/99percentpeople/weblink.git
cd weblink
```

已有源码缺少后端目录时执行：

```sh
git submodule update --init --recursive
```

从源码构建前端需要安装 [Bun](https://bun.sh/)，版本与根 `package.json` 的 `packageManager` 一致。使用 Docker 部署则安装 Docker Engine 或 Docker Desktop 以及 Compose，无需在主机安装 Bun。

## 配置前端 {#signaling-backend}

### 信令地址与环境变量 {#websocket}

先按[Server 部署](backend.md)或 [Worker 部署](worker.md)启动 Bun 服务或 Cloudflare Worker，取得浏览器可以访问的 WebSocket 地址。复制前端配置模板：

```sh
cp apps/web/.env.example apps/web/.env.local
```

编辑 `apps/web/.env.local`，将信令地址改为自己的后端：

```dotenv
VITE_WEBSOCKET_URL=wss://signal.example.com
WEBLINK_STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
```

| 配置                   | 用途                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| `VITE_WEBSOCKET_URL`   | 浏览器连接的信令地址。公网 HTTPS 页面使用 `wss://`；局域网 HTTP 测试可使用 `ws://192.168.1.20:9000` |
| `WEBLINK_STUN_SERVERS` | STUN 地址，多个以逗号分隔；可替换为自己的 STUN 服务                                                 |
| `VITE_TURN_SERVERS`    | 可选的自定义 TURN 中继，格式见 [STUN 与 TURN](#stun-and-turn)                                       |

面向其他设备时，不能把信令地址写成 `localhost`、`127.0.0.1` 或 Docker 服务名 `ws-server`。浏览器必须能从自己的网络访问这个地址；同一房间的成员必须使用相同的信令端点。

前端配置在**构建时**写入静态文件，修改后需要重新构建并上传。根目录 `.env` 用于组合本地开发，不能替代 `apps/web/.env.local`。Docker 构建不读取这些本地 env 文件，应按下文配置 Compose 构建参数。

所有 `VITE_*` / `WEBLINK_*` 前端配置都可能出现在公开 JavaScript 中。Cloudflare TURN 的服务商密钥只配置在后端。

用户在**设置 → 连接 → WebSocket 信令服务器**保存的地址会覆盖部署默认值。使用“重置”恢复默认地址，重新加入房间后生效。

## 构建与静态托管 {#static-hosting}

### 构建和本机预览 {#build-and-preview}

完成前端配置后，安装依赖并构建：

```sh
bun install --frozen-lockfile
bun run build
```

构建产物位于 `apps/web/dist/`。本机检查构建结果：

```sh
bun run preview --host 127.0.0.1 --port 4173
```

打开 `http://127.0.0.1:4173`，尝试加入房间。预览命令用于检查产物；长期提供服务请使用静态托管或 Web 服务器。

### 放到自己的域名下 {#publish-static-files}

将 `apps/web/dist/` **目录内的全部文件**上传到静态站点的根目录，包括资源、图标和 Service Worker。当前前端按域名根路径 `/` 构建，例如 `https://web.example.com/`。

若使用支持源码构建的静态托管平台，填写：

| 设置         | 值                                                                                  |
| ------------ | ----------------------------------------------------------------------------------- |
| 项目根目录   | 仓库根目录                                                                          |
| 安装命令     | `git submodule update --init --recursive`，然后 `bun install --frozen-lockfile`     |
| 构建命令     | `bun run build`                                                                     |
| 输出目录     | `apps/web/dist`                                                                     |
| 构建环境变量 | 上一节的 `VITE_WEBSOCKET_URL`、`WEBLINK_STUN_SERVERS`，以及可选 `VITE_TURN_SERVERS` |

平台构建需要在该平台配置环境变量，本机的 `.env.local` 不会随源码上传。

使用自己的 Nginx 时，可以将产物放到 `/var/www/weblink`，在对应站点配置中加入：

```nginx
root /var/www/weblink;
index index.html;

location / {
    try_files $uri $uri/ /index.html;
}
```

检查配置并重新加载已经运行的 Nginx：

```sh
sudo nginx -t
sudo systemctl reload nginx
```

为公网域名配置有效的 HTTPS 证书，同时确保信令地址使用 WSS。摄像头、麦克风、屏幕共享、剪贴板及 PWA 等浏览器功能通常需要安全上下文。

## Docker Compose：同时启动前后端 {#docker}

此方式会构建前端 Nginx 镜像和 Bun 信令镜像。先完成源码与子模块准备，再将根目录 `docker-compose.yaml` 调整为以下配置，替换其中的主机 IP：

```yaml
services:
  weblink:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        VITE_WEBSOCKET_URL: ws://192.168.1.20:8080/ws
        WEBLINK_STUN_SERVERS: stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
    ports:
      - "8080:80"
      - "443:443"
    environment:
      ENABLE_SSL: "false"
    volumes:
      - ./docker/ssl:/etc/nginx/ssl:ro
    depends_on:
      - ws-server
    restart: unless-stopped

  ws-server:
    build:
      context: ./servers/weblink-ws-server
    environment:
      HOSTNAME: 0.0.0.0
      PORT: "9000"
      NODE_ENV: production
      LOG_LEVEL: info
    ports:
      - "127.0.0.1:9000:9000"
    restart: unless-stopped
```

启动并查看状态：

```sh
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 weblink ws-server
```

在另一台设备打开 `http://192.168.1.20:8080`。浏览器通过同一入口的 `/ws` 连接后端，Nginx 在容器网络内转发到 `ws-server:9000`。示例仅向主机回环地址暴露后端 9000 端口；在服务器上可检查：

```sh
curl http://127.0.0.1:9000/healthcheck
```

返回 HTTP 200 表示后端已启动。修改 Compose 构建参数或 Nginx 模板后，再次执行 `docker compose up -d --build`。当前前端优先读取构建时的信令地址，仅更改容器运行时环境变量不会覆盖已经写入的值。

停止服务：

```sh
docker compose down
```

### 使用附带 Nginx 启用 HTTPS {#https-with-the-included-nginx-image}

1. 将自己的域名解析到服务器，准备浏览器信任且与域名匹配的证书。
2. 将证书链保存为 `docker/ssl/server.crt`，私钥保存为 `docker/ssl/server.pem`。
3. 在上面的 Compose 配置中，将 `ENABLE_SSL` 改为字符串 `"true"`，将 `VITE_WEBSOCKET_URL` 改为 `wss://web.example.com/ws`。
4. 允许客户端访问服务器的 443 端口，重新执行 `docker compose up -d --build`。
5. 打开 `https://web.example.com`，用两台设备加入同一房间。

模板启用 HTTPS 后仍保留 HTTP 入口，不会自动重定向。若由已有反向代理处理 HTTPS，可保留容器内 HTTP，并将入口转发到 8080 端口；代理必须支持 WebSocket upgrade，前端构建参数仍填写外部的 WSS 地址。

## STUN 与 TURN {#stun-and-turn}

STUN 帮助设备发现可用网络地址；跨运营商、严格 NAT 或防火墙环境可能还需要 TURN 中继。信令服务本身不转发文件和媒体。

如果已有 TURN 服务，可在 `apps/web/.env.local` 添加配置；Docker 则在 `weblink.build.args` 添加同名参数：

```dotenv
VITE_TURN_SERVERS=turn:turn.example.com:3478|user|password|longterm
```

每条配置为 `url|username|password|authMethod`，支持 `longterm` 和 `hmac`，多个条目用实际换行分隔。TURN 的地址、端口、认证方式和凭据需要与自己的服务一致。这些静态凭据会交付给浏览器。

### 使用后端提供的 Cloudflare TURN {#server-provided-cloudflare-turn}

按[Server TURN 配置](backend.md#turn)或 [Worker TURN 配置](worker.md#turn)设置 `TURN_KEY_ID` 和 `TURN_KEY_API_TOKEN` 后，前端会自动向信令源的 `/turn-credentials` 请求临时凭据。例如 `wss://signal.example.com/ws` 对应 `https://signal.example.com/turn-credentials`，无需再设置前端 TURN 服务商密钥或凭据接口地址。

附带 Nginx 模板默认只代理 `/ws`；使用此功能时还需按[反向代理说明](backend.md#tls-and-proxy)转发 `/turn-credentials`。不要在 `VITE_TURN_SERVERS` 中使用已移除的 `|cloudflare` 格式。

## 局域网使用 {#lan-deployment}

前面的 Docker HTTP 示例可用于局域网连接测试。分开部署时，Bun 后端监听 `0.0.0.0:9000`，前端填写 `ws://192.168.1.20:9000`，并允许客户端访问相应端口。

需要从源码临时启动前端时，完成依赖安装和 `.env.local` 配置后执行：

```sh
bun run dev:web --host 0.0.0.0
```

其他设备访问终端显示的局域网地址，默认端口为 5173。修改 env 文件后重启开发服务器。仅在本机测试时，前端和后端地址均可使用 `127.0.0.1`。

局域网 HTTP 页面上的媒体与剪贴板能力可能受浏览器限制；需要完整功能时，也应为局域网入口配置受设备信任的 HTTPS/WSS。

## 验证部署 {#production-checklist}

部署完成后，在两台设备上打开站点，确认使用相同的信令地址、房间 ID 和密码。检查能否看到成员、发送消息、传输文件，以及断开后重新加入。需要中继的网络还应验证 TURN；健康检查成功仅说明信令进程可用。

## 接下来想了解什么？ {#next-steps}

- **想同时提供预设好服务地址的桌面客户端**：继续阅读 [Tauri 端部署](tauri.md)。
- **还需要后端，准备使用自己管理的服务器**：选择 [Server 部署](backend.md)。
- **还需要后端，希望由 Cloudflare 托管**：选择 [Worker 部署](worker.md)。
- **网页已上线，但信令无法连接**：按 [WebSocket 排查步骤](../guide/faq.md#signaling-unreachable)检查。
