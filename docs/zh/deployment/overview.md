# 自部署导读

**可以只部署信令后端，继续使用现有 Weblink 网页或桌面端。** 在每个客户端修改 WebSocket 地址，就能连接自己的服务；自行托管前端或构建桌面安装包都是可选项。

想先理解组件分工和内容传输通路，可以阅读[架构概览](../architecture/overview.md)；本文帮助你选择需要自行运行的部分。

## 选择需要部署的部分 {#choose-scope}

| 你的目标                             | 需要准备什么                                                                  |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| 使用自己的房间与信令服务             | 部署一个 [Server](backend.md) 或 [Worker](worker.md)，配合现有 Weblink 客户端 |
| 改善无法直连的跨网络连接             | 准备可达的 STUN/TURN 服务，见[下方说明](#stun-and-turn)                       |
| 用自己的域名提供网页，或预设连接地址 | 按 [Web 端部署](hosting.md)托管前端，并连接选定的信令后端                     |
| 在桌面安装包中预设自己的服务地址     | 按 [Tauri 端部署](tauri.md)构建；现有安装包已经可以在设置中修改 WS 地址       |

Server 和 Worker 是两种可选的信令后端，不需要同时部署；它们本身都不是 TURN 中继。

## 只部署后端，直接使用现有客户端 {#signaling-only}

1. 在自己的主机部署 [Server](backend.md)，或在 Cloudflare 部署 [Worker](worker.md)，取得所有参与设备都能访问的 WSS 端点，例如 `wss://signal.example.com`。
2. 打开 [webl.ink](https://webl.ink) 或现有[桌面端](../guide/desktop.md)，进入**设置 → 连接 → WebSocket 信令服务器**，填写该端点。
3. 其他设备也修改为相同地址，再用相同房间 ID 和密码重新加入。客户端保存的设置优先于网站或安装包默认值，“重置”会恢复默认值。
4. 测试消息与文件传输。如果使用的网络需要中继，再按下方说明配置 TURN。

这会更换现有客户端使用的信令服务，无需重新构建前端或安装桌面端。浏览器仍需要能访问网站才能加载客户端；如果也想自己管理这个入口，再部署 Web 前端。

公网 HTTPS 网页需要使用证书有效的 WSS。桌面安装版连接非回环地址也要求 WSS，包括局域网主机。使用各台设备能访问的域名或 IP，不要填写 Docker 服务名或另一台电脑的 `localhost`。

## 判断是否需要 STUN 或 TURN {#stun-and-turn}

| 服务           | 作用                                           | 是否承载文件或媒体流量             |
| -------------- | ---------------------------------------------- | ---------------------------------- |
| WebSocket 信令 | 房间发现与连接协商                             | 否，交换连接信息不等于中继设备数据 |
| STUN           | 帮助设备发现对外网络地址，以尝试直连           | 否                                 |
| TURN           | 设备无法直连，或选择仅中继模式时，提供中继通路 | 是，经过中继的连接会使用它传输     |

STUN 不能保证穿过所有 NAT 或防火墙。直连不可用时，TURN 提供另一条通路，背景说明见 [WebRTC TURN 指南](https://webrtc.org/getting-started/turn-server)。使用自己的信令后端不要求同时自建 STUN/TURN，可以接入现有可达服务，也可以单独部署。

应从双方实际网络选择可达的端点。面向中国大陆用户时，需验证具体运营商与网络线路；某个托管平台或自定义域名本身不能保证可达。TURN 的位置、带宽和流量额度会影响中继体验及成本。

### 接入已有 STUN/TURN 服务 {#ice-configuration}

在**设置 → 连接**中，将 STUN 和 TURN 分别添加到对应列表；批量编辑时每行一条。下方示例地址与凭据都需要替换成自己的值。

STUN 通常只需填写 URL：

```text
stun:stun.example.com:3478
```

TURN 使用用户名和密码时，格式为 `URL|用户名|密码|longterm`。只添加服务实际提供的传输方式和端口：

```text
turn:turn.example.com:3478?transport=udp|user|password|longterm
turns:turn.example.com:5349?transport=tcp|user|password|longterm
```

其中 `turns:` 使用 TLS。这些是 ICE 服务器地址，应填写到 STUN/TURN 设置中，不能填入 WebSocket 地址栏。参与设备配置可用条目后重新连接。与信令不同，两端不必使用同一台 ICE 服务器，但各自必须能访问所使用的服务。

服务商签发的临时用户名和密码也可以按 `longterm` 填写，但到期后需要替换。认证方式与可用性检查见[连接设置](../guide/connection.md#ice-servers)。

### 使用托管 TURN {#managed-turn}

托管服务商负责运行中继。Weblink 的 Server 和 Worker 已内置 Cloudflare TURN 接入：在后端配置 `TURN_KEY_ID` 和 `TURN_KEY_API_TOKEN` 后，使用该信令端点的客户端会自动从它的 `/turn-credentials` 接口获取并刷新临时凭据。现有网页和桌面端也可以使用，无需重新构建前端。

服务商 Key 和 API Token 保留在后端，客户端只接收临时凭据，不接收签发凭据的密钥，相关机制见 [Cloudflare 凭据说明](https://developers.cloudflare.com/realtime/turn/generate-credentials/)。Weblink 的配置入口见 [Server TURN 设置](backend.md#turn)和 [Worker TURN 设置](worker.md#turn)。其他服务商可通过其提供的 TURN URL 和客户端凭据接入，但这两个配置项不会自动接入其他服务商的凭据 API。

### 自建 STUN/TURN {#self-hosted-turn}

[coturn](https://github.com/coturn/coturn) 是可同时提供 STUN 和 TURN 的开源服务。它与 Weblink 信令分别部署，可以运行在容量足够的同一台主机，也可以放在另一台可达的主机。部署前需要准备：

- 可达的服务器地址；位于 NAT 后方时，配置对外公布的公网地址及对应端口转发。
- 监听端口：常见为 UDP/TCP 3478，启用 TLS 时常见为 5349。还要在防火墙、安全组和 NAT 中放行配置的 UDP 中继端口范围，只开放监听端口不够。
- TURN 认证与 realm，配套用户凭据或临时凭据签发服务；提供 `turns:` 时配置证书。
- 与文件、媒体中继需求匹配的带宽和流量限制，以及凭据管理和服务监控。

具体选项见 [coturn 配置示例](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf)与[服务手册](https://github.com/coturn/coturn/wiki/turnserver)，按实际操作系统或容器环境选择安装方式。普通 HTTP 反向代理不能代替 TURN 的 UDP/TCP 监听和中继端口，需要与 WSS 代理分别规划网络入口。

## 从实际使用网络验证 {#verify}

1. 两台设备使用同一信令端点加入房间，确认成员发现，再发送消息和文件。
2. 在各自网络中对配置的 STUN/TURN 执行**检查可用性**。这只能检查服务访问情况，还需验证真实设备间传输。
3. 需要专门验证 TURN 时，使用有效凭据开启仅中继模式，重新连接并测试文件或视频，完成后恢复期望的模式；持续开启会让所有连接都依赖 TURN。
4. 在计划支持的网络中重复验证，例如家庭 Wi-Fi、移动数据和办公网络。大文件或屏幕共享还应检查实际中继吞吐。

验证时若服务不可达或设备间连接失败，可在[连接常见问题](../guide/faq.md#connection)中按现象查找对应步骤。
