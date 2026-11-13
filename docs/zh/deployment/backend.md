# Server 部署

在自己的服务器或局域网主机上运行 Bun 信令服务，帮助 Web 和 Tauri 客户端加入房间、发现成员并协商 WebRTC 连接。聊天、文件和媒体通过 WebRTC 传输，需要中继时由 TURN 服务承载流量。

单个 Server 实例无需 Redis。若希望由 Cloudflare 托管后端，改用 [Worker 部署](worker.md)；两种后端选择一种即可，连接同一房间的设备应使用同一个信令地址。

部署后可以继续使用现有网页或桌面端，在设置中修改 WebSocket 地址即可。[自部署导读](overview.md#signaling-only)说明了这条无需部署前端的路径。示例域名和 IP 均需替换为自己的地址。

## 准备环境与源码 {#prepare}

安装 Git 和 [Bun](https://bun.sh/)，Bun 版本与根 `package.json` 的 `packageManager` 一致，然后取得完整源码并安装依赖：

```sh
git clone --recurse-submodules https://github.com/99percentpeople/weblink.git
cd weblink
bun install --frozen-lockfile
```

已有源码时，在仓库根目录运行 `git submodule update --init --recursive` 补齐后端目录，再安装依赖。以下步骤从仓库根目录开始。

Docker 方式无需在主机安装 Bun，按 [Web 端的完整 Compose 示例](hosting.md#docker)准备源码，同时启动 Web 与 Server。下面是直接运行 Server 进程的方式。

## Bun 信令服务器 {#bun-server}

### 配置监听地址和端口 {#bun-configuration}

进入后端目录，复制配置模板：

```sh
cd servers/weblink-ws-server
cp .env.example .env.local
```

编辑 `servers/weblink-ws-server/.env.local`。最小单实例配置如下；未启用托管 TURN 时，清空模板里的两个 TURN 占位值：

```dotenv
HOSTNAME=0.0.0.0
PORT=9000
NODE_ENV=production
LOG_LEVEL=info
REDIS_URL=
TURN_KEY_ID=
TURN_KEY_API_TOKEN=
```

| 配置                                 | 说明                                                                               |
| ------------------------------------ | ---------------------------------------------------------------------------------- |
| `HOSTNAME`                           | 监听接口。`0.0.0.0` 接受其他设备连接；仅由同一主机反向代理访问时可改为 `127.0.0.1` |
| `PORT`                               | 信令与 HTTP 健康检查共用端口，默认 9000                                            |
| `NODE_ENV` / `LOG_LEVEL`             | 正常部署使用 `production` 和 `info`                                                |
| `REDIS_URL`                          | 单实例留空。多实例协作时填写 Redis 连接地址                                        |
| `TURN_KEY_ID` / `TURN_KEY_API_TOKEN` | 可选的 Cloudflare TURN 配置，见[下文](#turn)                                       |

Bun 从当前服务端目录读取 `.env.local`；也可以通过进程或容器环境变量提供配置。不要将后端配置放到 `apps/web/.env.local`。

### 启动并检查服务 {#bun-start}

保持在 `servers/weblink-ws-server` 目录执行：

```sh
bun run start
```

该命令在前台运行，终端显示服务日志；按 Ctrl+C 停止。在同一主机的另一个终端检查：

```sh
curl http://127.0.0.1:9000/healthcheck
```

返回 HTTP 200 表示服务已启动。若服务器局域网地址为 `192.168.1.20`，允许客户端访问 TCP 9000 后，HTTP 前端可使用 `ws://192.168.1.20:9000`。HTTPS 前端需要 WSS，按[反向代理与 TLS](#tls-and-proxy)配置。

修改 env 配置后重启进程。长期运行可交给自己的进程管理器，或使用带 `restart: unless-stopped` 的 [Docker Compose 示例](hosting.md#docker)在后台运行。

使用多个 Bun 实例时，将同一房间固定路由到同一个实例。Redis 可用于实例间协作，但仅配置 Redis 不会让各实例共享完整的房间校验与恢复状态；普通自部署可以保持单实例。

## 反向代理与 TLS {#tls-and-proxy}

HTTPS 页面和打包后的桌面客户端访问非回环地址时，应连接 `wss://` 信令。Server 可以由 Nginx 处理 TLS，也可以让 Bun 直接加载证书。

### Nginx 转发到 Bun {#nginx-proxy}

以下示例适用于 Nginx 与 Bun 在同一台主机运行。先将域名解析到服务器，并准备匹配域名的有效证书和私钥。将 Bun 的 `HOSTNAME` 改为 `127.0.0.1`，添加 `TRUSTED_PROXY_IPS=127.0.0.1`，然后重启后端。

在 Nginx 的站点配置目录添加以下 `server`，替换域名和证书路径：

```nginx
server {
    listen 443 ssl;
    server_name signal.example.com;

    ssl_certificate /etc/nginx/certs/signal.example.com.crt;
    ssl_certificate_key /etc/nginx/certs/signal.example.com.key;

    location / {
        proxy_pass http://127.0.0.1:9000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 90s;
    }
}
```

此配置转发 WebSocket、`/healthcheck` 以及 `POST` / `OPTIONS /turn-credentials`。允许外部访问 443 端口，检查并重新加载已经运行的 Nginx：

```sh
sudo nginx -t
sudo systemctl reload nginx
curl https://signal.example.com/healthcheck
```

前端使用 `wss://signal.example.com`。`TRUSTED_PROXY_IPS` 只填写直接连接 Bun 的可信代理地址；代理必须覆盖 `X-Real-IP`。如果 Nginx 在另一台主机或容器内，请改用实际可达的后端地址和代理 TCP 地址。

附带的 `docker/nginx.conf.template` 默认只转发 `/ws`。在 Docker 方案中启用托管 TURN 或希望从网站入口检查健康状态时，在同一个 `server` 内增加：

```nginx
location = /turn-credentials {
    proxy_pass http://ws-server:9000;
}

location = /healthcheck {
    proxy_pass http://ws-server:9000;
}
```

修改模板后执行 `docker compose up -d --build`。需要按客户端 IP 限流时，还应在模板的 `/ws` 代理中覆盖 `X-Real-IP`，并在 Bun 服务的 `TRUSTED_PROXY_IPS` 中配置该代理的实际 TCP 地址；否则代理后的客户端会共用限额。

### Bun 直接启用 TLS {#bun-tls}

不使用反向代理时，在服务端 `.env.local` 设置证书与私钥的绝对路径：

```dotenv
TLS_CERT_FILE=/path/to/server.crt
TLS_KEY_FILE=/path/to/server.key
```

保持 `HOSTNAME=0.0.0.0`，重启 Bun，允许客户端访问监听端口。若仍使用 9000 端口，检查 `https://signal.example.com:9000/healthcheck`，前端填写 `wss://signal.example.com:9000`。可选 `TLS_CA_FILES` 接受逗号分隔的 CA 文件路径。

## 可选：配置 Cloudflare TURN {#turn}

如果客户端网络需要中继，可以使用自己的 TURN 服务，也可以让信令后端提供 Cloudflare TURN 临时凭据。服务选择和客户端配置见 [STUN/TURN 导读](overview.md#stun-and-turn)，无需为此专门构建前端。

使用托管 TURN 时，准备 Cloudflare TURN 的 Key ID 和 API token，只在后端配置这两个值。未配置托管 TURN 时，信令仍能工作。

### Bun 或 Docker {#turn-bun}

在 Bun 服务端 `.env.local` 中填写实际值并重启：

```dotenv
TURN_KEY_ID=your-turn-key-id
TURN_KEY_API_TOKEN=your-turn-key-api-token
```

使用 Compose 时，将同名变量加到 **`ws-server.environment`** 后执行 `docker compose up -d ws-server` 使配置生效。这些值属于后端运行环境，不能放到前端的 `build.args` 中。

### 检查凭据接口 {#turn-verify}

将 URL 替换为实际信令源；使用 Docker 的 `/ws` 入口时，凭据接口仍位于根路径：

```sh
curl -i -X POST https://signal.example.com/turn-credentials
```

成功返回包含 `iceServers` 和 `expiresAt` 的 JSON，临时凭据有效期为 24 小时。前端自动请求并按需刷新凭据，无需额外配置接口 URL。

此接口公开访问，WebSocket 准入限流不覆盖它；如需限制调用量，在入口为该 HTTP 路径单独设置规则。反向代理应允许 `POST` 和 `OPTIONS`，并保留响应的跨域及禁止缓存头。

## 连接客户端并验证 {#verify}

1. 从客户端网络访问对应 `/healthcheck`，确认域名、证书和端口可达。
2. 打开现有 Weblink 网页或桌面端，[设置自己的信令地址](overview.md#signaling-only)；已经部署自有前端或安装包时，也可以使用它们。
3. 在两台设备上确认“设置 → 连接”没有覆盖为旧地址，使用相同房间 ID 和密码加入。
4. 验证成员发现、发送消息、传输文件以及断线后重新加入。需要 TURN 的网络还应验证中继连接。

## 接下来想了解什么？ {#next-steps}

- **想从现有网页连接这个后端**：按[客户端连接设置](overview.md#signaling-only)修改地址。
- **想让现有桌面客户端连接这个服务**：按[桌面客户端接入步骤](tauri.md#existing-package)设置。
- **希望改由 Cloudflare 托管信令**：继续阅读 [Worker 部署](worker.md)。
- **HTTP 健康检查正常，但客户端连不上**：按 [WebSocket 排查步骤](../guide/faq.md#signaling-unreachable)检查。
- **TURN 凭据请求失败**：查看[响应状态说明](../guide/faq.md#turn-credentials)。
