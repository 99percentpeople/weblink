# P2P 控制协议

设备建立 WebRTC 连接后，还需要一套应用契约来交换消息、文件请求、权限和能力。Weblink 的控制协议独立于界面和存储实现，定义这些交互；文件二进制分块与 RTP 媒体则使用各自的数据通路。

## 消息信封与路由 {#envelope}

控制消息是 JSON 对象，包含 `id`、`type`、`createdAt`、`client` 和 `target`。ID 将请求与应答对应起来；时间戳使用毫秒 Unix 时间；`client` 与 `target` 分别标识发送和接收设备。

一条私聊文本请求如下：

```json
{
  "id": "message-1",
  "type": "send-text",
  "createdAt": 1760000000000,
  "client": "device-a",
  "target": "device-b",
  "data": "Hello"
}
```

接收方先验证消息类型、数据结构和连接上下文，再交给处理器。`conversationId`、`deliveries`、`localSequence` 等本地数据库或界面字段不属于线上协议；收到的对象不会直接作为可信的本地记录写入应用状态。

房间聊天使用独立的 `send-room-text` 消息，数据中带有房间 ID 和双方当前的房间绑定 Token。通道打开时，设备通过 `room-capabilities` 交换新的 Token。消息信封仍指向一台设备：房间消息分别投递给在线接收者，由每一端验证所属房间。

## 应答究竟确认了什么 {#acknowledgments}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="P2P 请求与应答时序图" tabindex="0">

![文本请求通过验证并写入本地历史后，接收方才返回 ACK。应答丢失且启用重试时，发送方复用原 ID，接收方可返回保留的结果，无需重复执行处理器。](/diagrams/p2p-protocol-zh.svg)

</div>
<figcaption>图中以聊天请求为例。虚线表示去重记录仍有效时的重试交互；其他操作可能返回有明确类型的结果，而不是 ACK。</figcaption>
</figure>

对于上面的私聊文本，接收方使用相同 ID 回复，并交换发送和接收设备：

```json
{
  "id": "message-1",
  "type": "ack",
  "createdAt": 1760000000010,
  "client": "device-b",
  "target": "device-a",
  "mode": "receive"
}
```

ACK 表示对应处理器已成功完成。聊天处理器会等待本地历史写入后再应答，因此它确认的是当时的本地持久化，不代表用户已读、消息永远不会被删除，也不代表信令服务器持有副本。

不同操作有不同的应答契约：

| 操作                                                       | 应答及范围                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| `send-text`、`send-room-text`                              | 接收处理器完成后，以 `mode: "receive"` 的 `ack` 应答          |
| `request-file`、`request-room-file`、`request-shared-file` | 用 `mode: "send"` 的 `ack` 确认接受发送请求，文件完成另行跟踪 |
| 按内容身份发起的文件提议                                   | 返回 `file-offer-result`，说明能否复用内容或需要传输          |
| `request-storage`                                          | 返回 `storage`，携带一页共享文件元数据                        |

有明确类型的结果会直接完成原始请求。协议不会再对每条应答继续应答，形成无限确认循环。

## 超时、重试与重复请求 {#request-lifetime}

请求区分发送阶段和等待应答阶段。等待可用传输通道或发送队列，与数据已经发出后等待对端，是不同的状态。发送前取消，会移除排队请求，避免它稍后突然发出；发送后取消，则无法撤销对方已经执行的操作。

启用重试时，会复用原始数据、ID 和时间戳的快照，使一次逻辑操作不会变成几个互不相关的请求。接收方合并正在处理的重复请求；已完成的请求可以重放结果，不必再次调用处理器。

去重记录有边界：当前默认保留十分钟，最多 512 条，并且仅存在于协议会话的内存中。因此，它不提供跨应用重启或超出去重窗口的永久“恰好执行一次”保证。

关闭所属会话会拒绝待完成请求，并中止其处理器。退役会话中迟到的应答不能完成替代会话里的请求。调用方区分发送超时、应答超时、取消、连接关闭和远端处理失败，因为这些结果对“操作是否已经到达对方”的含义不同。

## 能力协商 {#capabilities}

设备声明自己实现的服务，而不是仅根据应用版本推测支持范围。`peer-capabilities` 消息可以携带完整快照或增量更新。下面的最小快照声明消息能力：

```json
{
  "id": "capabilities-1",
  "type": "peer-capabilities",
  "createdAt": 1760000000000,
  "client": "device-a",
  "target": "device-b",
  "version": 1,
  "update": {
    "kind": "snapshot",
    "generation": "connection-a",
    "revision": 1,
    "services": {
      "messaging/1": {}
    }
  }
}
```

服务键包含名称与主版本，例如 `messaging/1`、`files/1`。双方为当前连接选择共同实现的主版本。能力同步信封另有自己的版本，两者都不是 WebSocket 信令版本。

`generation` 将声明绑定到当前连接；完整快照建立基线，修订号防止迟到的增量覆盖较新的服务状态。增量可以用 `null` 撤回某项服务，但不能在连接进行到一半时，悄悄切换成另一主版本的实现。

能力说明实现范围和当前可用性，不授予操作权限。例如，对方声明支持远程控制或自动化后，目标设备仍要检查信任、权限和当前有效授权。

## 实现入口 {#implementation}

以下路径相对于 `apps/web/src/libs/domain/protocol/`。这是一个可移植模块，其内部导入保持在该目录中：

| 文件                                     | 职责                         |
| ---------------------------------------- | ---------------------------- |
| `messages.ts`、`validation.ts`           | 线上消息类型与验证           |
| `request-manager.ts`、`protocol.ts`      | 请求、应答、取消与去重       |
| `transport.ts`                           | 协议使用的传输边界           |
| `capabilities.ts`、`capability-state.ts` | 能力数据结构及快照、增量处理 |
| `protocol-versions.ts`                   | 已实现的服务版本与协商       |

应用处理器再将这套契约连接到本地历史、文件存储、媒体及权限服务。这样的分工使浏览器与桌面传输可以共用同一套交互规则。

## 接下来想了解什么？ {#next-steps}

- **想从文件请求继续追踪二进制数据**：阅读[文件传输与断点续传](file-transfer.md)。
- **想理解支持某项功能后为什么仍需批准**：阅读[设备身份与授权](device-trust.md)。
- **想实际使用房间消息和附件**：按照[房间与聊天](../guide/rooms.md)中的步骤操作。
