# 信令服务

Weblink 仅使用信令发现 peer 和建立 WebRTC 连接。WebRTC 就绪后，应用消息、文件、媒体、显示名称和头像都通过 peer-to-peer 交换。

安装、配置与启动步骤见 [Server 部署](../zh/deployment/backend.md)或 [Worker 部署](../zh/deployment/worker.md)。本页说明协议和运行时行为。

## 可用实现 {#implementations}

| 服务              | 仓库                                                                        | 运行时                               | 用途                          |
| ----------------- | --------------------------------------------------------------------------- | ------------------------------------ | ----------------------------- |
| Cloudflare Worker | [`weblink-ws-worker`](https://github.com/99percentpeople/weblink-ws-worker) | Cloudflare Workers + Durable Objects | 推荐的无服务器 WebSocket 部署 |
| Bun 服务器        | [`weblink-ws-server`](https://github.com/99percentpeople/weblink-ws-server) | Bun，可选 Redis                      | 自托管或回滚部署              |

已部署的 Cloudflare 候选端点为：

- 健康检查：`https://ws.webl.ink/healthcheck`
- WebSocket：`wss://ws.webl.ink`
- Workers.dev 备用地址：`https://weblink-signaling.myzzzyearz-e00.workers.dev`

## Cloudflare 房间模型 {#cloudflare-room-model}

Worker 将每个房间 ID 映射到一个 `SignalingRoom` Durable Object。房间对象负责成员关系、密码哈希、WebSocket 附件数据、重连宽限期和信令消息队列。通过 WebSocket Hibernation API，空闲房间不需要持续活动的 Worker 实例。

Worker 支持现有 Weblink WebSocket 协议：

- `connected`
- `join`，随后返回带版本的 `joined` 确认
- `leave`
- 用于 SDP offer/answer 和 ICE candidate 的 `message`
- `ping` / `pong`
- 重连与 90 秒消息缓存

## 可移植的信令契约 {#portable-signaling-contract}

前端中与传输方式无关的信令 DTO、解析器及已部署限制位于 `apps/web/src/libs/domain/signaling-protocol.ts`。浏览器重连计时器和 WebSocket 生命周期属于基础设施职责，不纳入此契约。

WebSocket 信令契约共用 `SIGNALING_PROTOCOL_VERSION`，通过 `joined.protocolVersion` 报告。兼容扩展复用现有版本，单个通知载荷不单独携带版本。只有必要变更与已部署客户端冲突时才升级，并同时更新前端和两个信令服务器。

当前版本仍为 **2**，限制如下：

| 限制                     |           值 |
| ------------------------ | -----------: |
| client ID 长度           |   128 个字符 |
| room ID 长度             |   256 个字符 |
| 密码哈希长度             | 1,024 个字符 |
| 单条编码后的信令消息     |        1 MiB |
| 每个客户端缓存的重连信令 |       256 条 |

每个 WebSocket 信令帧都是 JSON envelope：

```json
{
  "type": "message",
  "data": {}
}
```

公开 presence 结构如下：

```json
{
  "clientId": "peer-id",
  "createdAt": 1760000000000,
  "rtcProfileVersion": 1,
  "resume": true
}
```

只有 `clientId` 和 `createdAt` 必填，资料显示数据不属于 presence。

路由到 peer 的信令帧结构如下：

```json
{
  "type": "message",
  "data": {
    "type": "offer",
    "clientId": "sender-id",
    "targetClientId": "receiver-id",
    "sessionId": "optional-session-id",
    "data": "opaque-or-encrypted-payload"
  }
}
```

信令后端验证 `clientId` 所有权，只按发送方与目标身份路由，将内层 `data` 当作不透明载荷。Weblink 浏览器客户端可以在发送 SDP/ICE 对象前使用房间密码加密该载荷。

有密码的浏览器和桌面客户端采用同一 PBKDF2-SHA-256 verifier，参数为 100,000 次迭代、16 字节盐、32 字节输出，并使用 AES-256-GCM 信令封装：把 16 字节盐、12 字节 IV、密文和 16 字节认证标签拼接后转为 Base64。局域网 HTTP 中原生 Web Crypto 不可用时，使用按需共享 worker，通过 WASM 派生密钥和执行 AES-GCM。每个 peer 传输复用派生的发送密钥，每条消息使用新的随机 IV，并缓存有数量上限的接收盐密钥。传输关闭时销毁这些密钥。密码准备失败会拒绝加入。

未来原生客户端必须遵循以下生命周期：

1. 使用 `room` 和可选 `pwd` 查询参数打开 WebSocket。
2. 等待 `connected`，在本地验证返回的房间密码哈希。
3. 发送携带公开 presence 的 `join`。
4. 对协议 v2 服务器，等待 `joined` 后才认为成员关系已建立，或重放 peer 工作。
5. 处理 `join` / `leave` presence 帧和路由后的 `message` 帧。
6. 收到 `ping` 时回复 `pong`。
7. 尝试恢复保留会话时，使用同一 client ID 与 `resume: true` 重连。
8. 替代连接拥有该 client ID 后，不再复用旧 socket。

两个 WebSocket 后端都为每条连接维护内部所有权 token，它不属于公开线上格式。这可防止旧 socket 的迟到 message、leave、close 事件修改替代会话。Worker 还会在 Durable Object 休眠期间持久保存该 token。

Bun 服务器和 Worker 是 `servers/` 下固定版本的 Git 子模块，保留独立仓库、依赖和契约测试。根信令 CI 初始化两者，再运行各自检查。未来共享 fixture 必须通过可独立消费的包或规范来源分发，不能从服务器仓库外导入文件。检出与更新命令见[工作区开发](../development/workspace.md)。

### 浏览器标签页所有权 {#browser-tab-ownership}

WebSocket 客户端在可用时使用 Web Locks，让同源标签页中每个信令端点、房间、client ID 组合仅持有一条连接。临时网络重连期间保留所有权，离开或首次加入失败时释放。其他房间和身份互相独立。

重复加入会显示全页遮罩。只有点击**切换到此页面**才会发送 BroadcastChannel 接管请求。旧页面先离开房间、取消传输和采集、关闭会议 PiP 窗口并释放锁，新页面随后连接，旧页面则显示相同遮罩。若旧页面五秒内未响应，切换失败，不会强占锁；关闭无响应页面后可重试。

阻塞页面观察本地锁是否可用，在所有者关闭标签页或离开房间时尝试正常加入。focus/pageshow 也会恢复可用性检查，但不会排在显式接管请求之前。多个页面同时恢复时仍由普通排他锁决定赢家，其他页面继续等待，不打开 WebSocket。临时网络断开不释放所有权。手动接管、离开、凭据变化和应用销毁会取消待处理自动恢复。恢复房间不会重新开启之前接管时已停止的摄像头或麦克风采集。

本地标签页替换与服务器报告的会话替换不同；只有经验证的本地冲突才允许自动恢复。不支持锁查询的浏览器保留手动切换操作。

对旧客户端或没有 Web Locks 的浏览器，服务器明确返回 `Session resumed elsewhere`、`Session replaced`（1000）或 `Stale client session`（1008）关闭原因时，会停止自动重连。普通网络关闭仍会重连。这些检查不改变信令线上格式。

### WebSocket 存活检测 {#websocket-liveness}

浏览器 WebSocket 显示打开，并不足以证明信令可达。加入房间后，客户端连续 15 秒未收到流量会发送 `{"type":"ping"}`，若 10 秒内没有响应就替换 socket。任何传入帧都计为活动，包括旧服务器主动发送的 `ping`。Worker 已通过休眠自动响应回复这一精确的 ping envelope，因此无需改变线上格式。

获得焦点、恢复可见、页面恢复和网络上线事件会立即探测传输。重复事件不会延长正在等待的探测截止时间。无响应 socket 会直接脱离，不等待其 `close` 事件；对应 peer 信令发送器变为断开状态，现有房间恢复循环安装替代连接。心跳计时器与监听器属于该 socket，在替换或退出房间时移除。超时单独记录为 `[WebSocketClientService] heartbeat timeout`，与 SDP/ICE 失败区分。

### 连接日志 {#connection-logging}

连接代码使用原生 console 级别，不引入运行时 logger：

| 级别    | 用途                                                                                        |
| ------- | ------------------------------------------------------------------------------------------- |
| `info`  | 房间信令就绪、WebRTC 已连接、开始恢复、会话所有权替换、显式退出房间。                       |
| `warn`  | socket 丢失、心跳超时、首次 WebSocket 重连失败、格式错误的信令、兼容回退和可恢复失败。      |
| `error` | SDP 处理失败、会话初始化失败、意外的 WebSocket 重连循环失败。                               |
| `debug` | 单条信令，仅类型和 peer ID，中间状态、预期 offer 冲突、过期信令、重复重试及取消、清理细节。 |

不要记录完整 SDP、ICE candidate、房间密码、TURN 凭据或 peer 资料载荷。关键事件可按需包含 client、peer 标识以区分对象。SDP 失败记录操作、信令状态与连接代次，不记录交换载荷。连接状态日志由 peer 会话负责，应用和 UI 监听器不重复记录。
事件触发的 peer 恢复失败时，只记录一次含原因的警告，然后等待新的可用性事件，不耗尽重试循环。被连接替换拒绝的待处理 SDP 操作或通道恢复属于 `debug` 清理，不是新连接失败。同一重试循环中反复发生的 WebSocket 握手关闭也使用 `debug`；成功恢复后的下一次中断才再次警告。

`vite build` 默认采用 production 模式。该模式下，`vite.config.ts` 的生产 esbuild 选项移除直接 `console.log`、`console.debug`、`console.trace` 调用和 `debugger` 语句，保留 `info`、`warn`、`error`。主应用和 Web Worker 使用 Vite 的 esbuild 选项，PWA service worker 构建显式接收同一配置；其他模式保留详细日志。
配置使用选择性的 `pure` 调用，不用 `drop: ["console"]`，以保留参数副作用与重要诊断。不会替换全局 console，也不改写第三方 SDK 的动态日志分发，它们继续使用各自的日志级别控制。

### 房间加入确认 {#room-join-acknowledgment}

密码验证后，客户端发送 `join`。协议版本 2 服务器在安装房间成员关系之后才回复：

```json
{
  "type": "joined",
  "data": {
    "protocolVersion": 2,
    "resumed": true
  }
}
```

只有服务器恢复了保留会话时，`resumed` 才为 `true`。服务器在已有成员 presence 和缓存 SDP/ICE 之前发送该确认。前端在确认到来前缓冲房间与 peer 信令，随后发布连接就绪、重新绑定所有 peer 信令通道，再按顺序重放缓冲。十秒内缺少确认会导致加入失败；仅打开 socket 不代表已成为房间成员，也不会创建房间历史。自托管服务器必须按上述版本 2 格式确认加入。

重连确认返回 `resumed: false` 时，客户端先淘汰旧 peer 会话，再接受新成员表。在 ICE 配置加载期间已经离开的 peer，不能被旧的待处理加入操作重新安装。信令恢复会请求一次被中断的 peer 协商恢复，包括首次连接，同时保留健康的 WebRTC 连接。信令断开期间恢复是被动的，不分配 peer 连接，也不反复启动等待信令计时器。离开会取消待处理连接工作。

较早的 presence 时间戳选择 polite 协商角色；时间戳相同则按 client ID 字典序比较，因此即使同一毫秒加入，双方角色也相反。同时 offer 冲突使用 polite rollback/answer 行为。只有 impolite 端在首次 offer 中提供数据通道，防止轨道数量不同的冲突 offer 留下竞争 SCTP 媒体段。只有 polite 端发起时，先建立媒体连接，连接后再协商数据通道。
每个 peer 最多拥有一次事件触发恢复尝试；已退休连接的异步失败不能断开替代连接。重建 peer 复用仍活动的本地采集轨道，不再次请求设备权限。已经开始的传入协商必须等到 WebRTC 报告 `connected` 才结束等待，`connecting` 不代表恢复成功。

### 事件驱动的 peer 恢复 {#event-driven-peer-recovery}

两个 WebSocket 后端在确认保留客户端恢复，并重放其缓存 SDP/ICE 后，通知其他当前在线成员：

```json
{
  "type": "peer-online",
  "data": {
    "clientId": "returning-client",
    "connectionId": "server-assigned-socket-id"
  }
}
```

此通知由服务器发出，不是成员 `join` / `leave`，也不是加密的 peer 消息；它报告信令可用，不代表 ICE 就绪。通知不存入离线成员信令缓存，同一 socket 重复 `join` 不会再次广播。Bun 还通过已有 Redis 通道转发到其他实例。
前端验证标识符，忽略自己和未知 peer，按连接 ID 去重，仅在本地房间确认之后向现有 peer 会话投递 `peeravailable`。旧 socket 事件被忽略。

本地已确认的信令恢复、远端 `peer-online`、浏览器 `online` 或实际页面冻结后的恢复，都可以请求一次连接尝试。真实 P2P 传输失败也允许一次尝试，即使 WebSocket 一直连接；服务器无法从信令 presence 推断 peer-to-peer 传输失败。
尝试失败后，会话等待新的可用性事件、传入 offer 或明确的手动重连。没有 peer 重试循环、指数退避、尝试次数上限或周期轮询。尝试期间的新可用性事件会被合并，待当前尝试结束再处理；失败回调本身不会要求再次尝试。普通获得焦点、切换标签页不触发重试。

WebSocket 重连与退避仍保留，因为离线浏览器必须先恢复服务器连接才能收到可用性通知。一次性的临时 ICE 断开宽限期和连接截止时间也保留，它们不是重试计划。本地或远端仅信令中断时，健康的 WebRTC、媒体连接继续保留。仅本地 SDP 拒绝不会触发 peer 恢复。

先部署新 WebSocket 服务器，再部署前端，以启用 peer-online 唤醒。加入确认仍为协议版本 2；此兼容新增事件复用共享版本，不携带载荷版本，旧客户端会忽略。旧服务器仍支持本地信令恢复和传入 offer 恢复，但不能用新通知唤醒 socket 未变化的 peer。

### WebRTC 连接代次 {#webrtc-connection-generations}

每个新 `RTCPeerConnection` 都生成随机连接 `generation`。前端将它放入 SDP offer、answer 和 ICE candidate 的加密 JSON 载荷中：

```json
{
  "sdp": "...",
  "generation": "b86d7dca-..."
}
```

接受 offer 的 peer 采用其 generation，并在 answer 与本地 ICE candidate 中回传。匹配 offer 之前到达的 candidate 按 generation 排队。替换 peer 连接时，旧 generation 退休，防止迟到 answer 和 candidate 污染替代连接。为兼容旧客户端，仍接受没有 `generation` 的载荷。

本地 SDP 应用与传入信令共用每连接队列。操作轮到执行时，控制器重新检查信令状态；后排队的本地意图不能导致更早的远端 offer 被忽略。替换 peer 连接会脱离旧队列，旧浏览器 SDP 操作即使未完成，也不能阻塞新信令。拒绝与当前 generation 冲突的 offer 时不能退休该 generation，因为本地 offer 的 answer 和 ICE candidate 仍属于它。

已协商 peer 连接收到新的、未退休 generation 的 offer，表示远端重启，不是普通重新协商。应用它之前应替换旧 peer 连接，即使本地 ICE 仍看似已连接，或本地重新协商尚未完成。重新绑定现有本地采集轨道，只迁移新 generation 的缓冲 ICE 与排队信令。首次同时 offer 仍使用 polite rollback，同代次媒体重新协商保留原 peer 连接。

### 协商与连接所有权 {#negotiation-and-connection-ownership}

`PeerSession.replaceConnection` 是 peer 连接创建、替换的唯一入口，供首次建立、本地恢复和已接受远端重启共用。房间发送器订阅属于会话，在传输替换后继续存在。每个 peer 连接有自己的 abort 生命周期；替换时取消其信令、连接等待和媒体、通道监听器。迟到的原生 SDP 完成不能发送信令或修改替代连接，旧原生 promise 也不阻塞新队列。有效远端重启会取代旧自动恢复尝试。本地采集和应用订阅继续保留；离开时销毁两个生命周期。

首次连接、恢复显式启动 `PeerNegotiationController.sendOffer`。已有 SDP 交换后，原生 `negotiationneeded` 是本地媒体与数据通道重新协商的唯一驱动，使用同一控制器、队列。媒体控制器只修改轨道与编解码器偏好，不请求 offer。等待 answer 期间，原生 WebRTC 合并媒体变化。应用没有 dirty 标记、stable-event drain 或重新协商计时器。

Offer 和 answer 使用无参数的 `setLocalDescription()`，由浏览器选择、生成并应用合适描述。信令原样发送结果 `localDescription`。Weblink 不解析、归一化或重写 SDP header-extension ID。原生 SDP 拒绝会记录日志，不循环重试同一份未变化 offer，也不关闭原本正常的媒体连接。仅本地 offer 失败不能证明远端媒体接收或显示已停止。

信令后端把加密载荷当作不透明数据；连接 generation 不要求修改后端协议。

## 隐私边界 {#privacy-boundary}

信令 presence 有意只包含连接元数据：

- `clientId`
- `createdAt`
- `rtcProfileVersion`
- 重连时的 `resume`

`name` 和 `avatar` 不属于信令 presence。旧或修改过的客户端发送这些字段时，两个 WebSocket 后端都会丢弃。前端信令客户端也忽略旧资料字段，在版本化 `client-profile` 消息通过 WebRTC DataChannel 抵达之前，创建本地匿名占位资料。

信令服务仍能观察房间成员关系、client ID 和连接建立时间。WebRTC 建立前，SDP offer/answer 与 ICE candidate 必须经过信令，但 Weblink 使用房间密码加密信令载荷。

## 部署 {#deployment}

前端环境变量、静态托管、Docker、Cloudflare Worker 与 Bun 服务器部署、ICE 配置、局域网设置和上线检查统一见[部署说明](../zh/deployment/hosting.md)。

本页仅维护信令架构、线上行为、隐私边界以及重连、会话所有权语义。
