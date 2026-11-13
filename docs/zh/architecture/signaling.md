# 信令与会话恢复

Weblink 使用 WebSocket 信令建立和恢复设备连接，随后通过 WebRTC 传输聊天、文件数据和媒体。本篇沿着信令握手说明连接如何建立、重连如何保留正确的会话，以及后端状态与内容投递的区别。

## 加入房间是一段握手过程 {#join}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="房间握手与重连流程图" tabindex="0">

![客户端 A 加入信令，先收到 joined，再处理成员与缓存信令，然后与客户端 B 协商，配对后通过 WebRTC 传输内容。恢复会话保留健康连接，全新加入退役旧设备状态。](/diagrams/signaling-zh.svg)

</div>
<figcaption>交互按从上到下的顺序发生。重连走哪个分支，取决于后端的 joined 应答，而不只是客户端是否请求 resume。</figcaption>
</figure>

WebSocket 连通只代表传输通道可用。客户端还需要完成房间握手，才能认为自己已加入房间：

1. 使用房间 ID 和可选的房间密码信息，连接配置的 WS/WSS 端点。
2. 等待 `connected`，检查房间密码信息；遇到身份挑战时，提供所需证明。
3. 发送带有本地在线记录的 `join`。在线记录包含 `clientId` 和 `createdAt`，重连时可以请求 `resume: true`。
4. 等待有效的 `joined` 响应。当前共用的信令协议版本为 **2**。
5. 处理现有成员列表和转发来的协商消息。

应答会明确说明后端是否恢复了保留的会话：

```json
{
  "type": "joined",
  "data": {
    "protocolVersion": 2,
    "resumed": true
  }
}
```

后端先发送此应答，再发送成员列表和缓存信令。这个顺序让客户端在处理后续消息前，决定保留还是退役原来的设备连接状态。仅打开连接或发送 `join`，不能证明已经成功加入房间。

## SDP 与 ICE 如何转发 {#routing}

SDP offer / answer 描述拟建立的连接和媒体，ICE candidate 描述可能使用的网络通路。两者都借助信令服务送达另一台设备，服务本身不会代替设备建立点对点连接。

转发报文采用以下结构。内部字符串是实际协商数据的占位符，不是 SDP 示例：

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

后端检查发送方是否拥有所声明的 `clientId`，再按 `targetClientId` 转发，不解释内部数据的业务含义。设置了密码的客户端可以使用房间密码加密协商数据，但这不会向服务隐藏房间成员、客户端 ID 或消息时间。

协议还包含 `leave` 和 `ping` / `pong`。显示名称与头像通过设备连接交换，不属于公开的在线记录。房间密码负责房间准入，设备配对与操作权限则由另外的机制决定。

## 恢复连接时不复活旧会话 {#recovery}

一次连接中存在几种不同的身份和状态。将它们分开，才能避免迟到的回调或数据影响替代连接。

| 身份或状态         | 用途                                 |
| ------------------ | ------------------------------------ |
| `clientId`         | 标识房间信令中的参与者               |
| Socket 所有权      | 让后端区分当前连接与已被替换的旧连接 |
| 连接代次           | 将协商和设备状态绑定到本次连接尝试   |
| 可选的 `sessionId` | 将信令送到指定的设备会话             |

Socket 所有权属于后端状态，不是调用方需要给每条报文增加的字段。旧连接迟到的关闭或离开事件，不能移除已由新连接接管的成员。

重连时，`resumed: true` 表示服务确实恢复了保留状态；`resumed: false` 则要求客户端在处理新成员列表前退役旧设备状态。请求恢复，并不保证后端还保存着原来的会话。

短暂的信令中断本身不要求销毁仍然健康的 WebRTC 连接。新协商和失效设备连接的恢复仍需要信令；信令回来后，客户端根据恢复事件协调重连，而不是在信令不可用时不断创建连接。取消或替换会话，也会取消属于它的待处理任务。

## 同时发起协商与过期候选地址 {#negotiation}

两台设备可能同时发起协商。Weblink 根据在线记录的顺序分配确定的 polite / impolite 角色，时间相同时使用客户端 ID 决定顺序。polite 一侧可以回滚发生冲突的本地 offer，另一侧可以忽略冲突 offer，使双方用一致的规则解决竞争。

协商还通过 `connectionId` 跟踪连接代次。来自旧代次的 ICE 不能仅因为发送者的客户端 ID 相同，就应用到新建的设备连接。这些规则用于处理快速重连、网络切换和并发媒体更新。

SDP 交换成功后，WebRTC 仍需要找到可用通路。STUN 辅助发现地址，TURN 在需要时提供中继。房间成员在线或收到 `joined` 应答，也不能证明接收端能够解码所选媒体编码。

## 后端保存哪些状态 {#backend-state}

Bun Server 与 Cloudflare Worker 实现同一套客户端信令契约。Worker 中，每个房间对应一个 Durable Object，负责成员、密码信息、WebSocket 附件和有界的重连状态。WebSocket 休眠机制允许空闲房间停止持续执行，同时保留连接。

重连队列中保存的是协商消息，不提供离线聊天、文件归档或媒体录制。重连状态有容量和时间边界，状态丢失后，客户端必须能够重新加入。

## 实现入口 {#implementation}

以下路径相对于仓库根目录：

| 路径                                                     | 职责                               |
| -------------------------------------------------------- | ---------------------------------- |
| `apps/web/src/libs/domain/signaling-protocol.ts`         | 可移植的报文、解析、协议版本与限制 |
| `apps/web/src/libs/infrastructure/signaling/`            | WebSocket 传输、握手与重连处理     |
| `apps/web/src/libs/application/room-service.ts`          | 房间成员及生命周期协调             |
| `apps/web/src/libs/application/rtc/rtc-service.ts`       | 设备连接协商与恢复                 |
| `servers/weblink-ws-server`、`servers/weblink-ws-worker` | 两种可选的信令后端                 |

## 接下来想了解什么？ {#next-steps}

- **想了解连接后设备之间交换什么**：继续阅读 [P2P 控制协议](p2p-protocol.md)。
- **想选择自己的信令或中继服务**：参考[自部署导读](../deployment/overview.md)。
- **设备已经出现，但内容仍无法连接**：按[设备连接排查步骤](../guide/faq.md#peer-connection)定位问题。
