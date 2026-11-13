# Worker 部署

将信令服务部署到自己的 Cloudflare Workers 账号，由 Durable Objects 管理房间。Web 和 Tauri 客户端使用部署后的 WSS 地址连接，不需要另外运行 Bun Server、Redis 或常驻主机进程。

Worker 与 [Server](backend.md)是两种可选后端；连接同一房间的设备需使用相同的信令地址。Worker 负责信令，消息、文件和媒体通过 WebRTC 传输，需要中继时使用 TURN。

可以直接修改现有网页或桌面端的 WS 地址来连接，无需部署前端，见[自部署导读](overview.md#signaling-only)。

## 准备环境与源码 {#prepare}

安装 Git 和 [Bun](https://bun.sh/)，Bun 版本与根 `package.json` 的 `packageManager` 一致，然后取得完整源码并安装依赖：

```sh
git clone --recurse-submodules https://github.com/99percentpeople/weblink.git
cd weblink
bun install --frozen-lockfile
```

已有源码时，在仓库根目录运行 `git submodule update --init --recursive` 补齐后端目录，再安装依赖。以下步骤从仓库根目录开始。

还需要自己的 Cloudflare 账号，能够使用 Workers 和 Durable Objects。默认可使用 Workers.dev 地址；自定义域名需由该 Cloudflare 账号管理。

## 配置并部署 Worker {#cloudflare-worker}

### 配置自己的 Worker {#worker-configuration}

编辑 `servers/weblink-ws-worker/wrangler.jsonc`。首次部署可先使用 Workers.dev 地址，不启用可选的托管 TURN：

| 字段               | 设置                                                                  |
| ------------------ | --------------------------------------------------------------------- |
| `name`             | 改为自己账号内使用的名称，例如 `my-weblink-signaling`                 |
| `workers_dev`      | 保持 `true`，使用部署命令输出的 Workers.dev 地址                      |
| `routes`           | 改为 `[]`，移除仓库内的项目域名 `ws.webl.ink`                         |
| `secrets.required` | 暂设为 `[]`。模板要求的两个 Secret 属于可选 TURN 功能，稍后可按需配置 |

保留其余配置，尤其是 `ROOMS` 绑定、`SignalingRoom` 导出及 SQLite 存储设置。保留 `WS_CONNECT_LIMITER`，并确认它的 `namespace_id` 在自己的账号内唯一。

需要自定义域名时，将 `routes` 设置为自己的 Cloudflare 账号管理的域名：

```json
[
  {
    "pattern": "signal.example.com",
    "custom_domain": true
  }
]
```

上面的数组只替换 `routes` 的值，不要覆盖整个配置文件。

### 登录并部署 {#worker-deploy}

从仓库根目录进入 Worker 目录，登录自己的账号并部署：

```sh
cd servers/weblink-ws-worker
bunx wrangler login --device
bun run deploy
```

按终端提示完成账号授权。部署完成后，复制输出的 HTTPS 地址，将下面示例域名替换为实际地址并检查：

```sh
curl https://my-weblink-signaling.example.workers.dev/healthcheck
```

返回 HTTP 200 后，前端配置为 `wss://my-weblink-signaling.example.workers.dev`。使用自定义域名时则填写 `wss://signal.example.com`。

Worker 不需要自己维护常驻进程。修改 Worker 配置后，在同一目录再次执行 `bun run deploy`。

## 可选：配置 Cloudflare TURN {#turn}

如果客户端网络需要中继，可以使用自己的 TURN 服务，也可以让信令后端提供 Cloudflare TURN 临时凭据。服务选择和客户端配置见 [STUN/TURN 导读](overview.md#stun-and-turn)，无需为此专门构建前端。

使用托管 TURN 时，准备 Cloudflare TURN 的 Key ID 和 API token，只在后端配置这两个值。未配置托管 TURN 时，信令仍能工作。

### 设置生产环境密钥 {#turn-worker}

完成前面的首次部署后，从仓库根目录进入 Worker 目录，按命令提示分别输入两个值：

```sh
cd servers/weblink-ws-worker
bunx wrangler secret put TURN_KEY_ID
bunx wrangler secret put TURN_KEY_API_TOKEN
bun run deploy
```

配置齐全后，可将 `secrets.required` 恢复为 `["TURN_KEY_ID", "TURN_KEY_API_TOKEN"]`，使后续部署检查它们是否存在。本地 Worker 调试使用 `.dev.vars`；该文件不会自动配置生产 Secret。

Secret 管理方式也可参考 [Cloudflare Secrets 文档](https://developers.cloudflare.com/workers/configuration/secrets/)。

### 检查凭据接口 {#turn-verify}

将 URL 替换为实际 Worker 的域名，凭据接口位于根路径：

```sh
curl -i -X POST https://signal.example.com/turn-credentials
```

成功返回包含 `iceServers` 和 `expiresAt` 的 JSON，临时凭据有效期为 24 小时。前端自动请求并按需刷新凭据，无需额外配置接口 URL。

此接口公开访问，WebSocket 准入限流不覆盖它；如需限制调用量，在入口为该 HTTP 路径单独设置规则。自定义访问规则或额外代理需允许 `POST` 和 `OPTIONS`，并保留响应的跨域及禁止缓存头。

## 连接客户端并验证 {#verify}

1. 从客户端网络访问对应 `/healthcheck`，确认域名、证书和端口可达。
2. 打开现有 Weblink 网页或桌面端，[设置自己的信令地址](overview.md#signaling-only)；已经部署自有前端或安装包时，也可以使用它们。
3. 在两台设备上确认“设置 → 连接”没有覆盖为旧地址，使用相同房间 ID 和密码加入。
4. 验证成员发现、发送消息、传输文件以及断线后重新加入。需要 TURN 的网络还应验证中继连接。

## 接下来想了解什么？ {#troubleshooting}

- **想从现有网页连接自己的 Worker**：按[客户端连接设置](overview.md#signaling-only)修改地址。
- **想接入桌面客户端，或预设安装包中的服务地址**：继续阅读 [Tauri 端部署](tauri.md)。
- **中国大陆客户端访问 Worker 缓慢或失败**：按[信令可达性检查](../guide/faq.md#signaling-mainland)定位。
- **想排查 TURN 凭据接口返回的错误**：查看 [TURN 凭据常见问题](../guide/faq.md#turn-credentials)。
