# Weblink P2P 控制协议

控制协议有意独立于 Weblink 的 Solid UI、IndexedDB store、信令后端以及浏览器 `PeerSession` 实现。

以下三类职责相互区分：

1. **信令**发现房间 peer，交换 SDP/ICE 直至 peer 连接建立。
2. **P2P 控制协议**通过可靠消息传输交换类型化 JSON 请求、响应和通知；传输是否有序是可选的。
3. **数据协议**，例如文件载荷传输和测速，使用自己的通道与状态机，不编码为控制消息。

未来桌面、移动或原生客户端应实现 `apps/web/src/libs/domain/protocol/` 的线上契约，并提供自己的传输、会话适配器，无需依赖 Weblink 的 `PeerSession`、Solid 状态、IndexedDB 或 UI 服务。

## 可移植客户端边界 {#portable-client-boundary}

TypeScript 参考实现暴露最小的、与传输方式无关的契约：

```ts
type ProtocolSession = {
  clientId: string;
  targetClientId: string;
};

interface ProtocolTransport<S extends ProtocolSession> {
  send(
    session: S,
    message: SessionMessage,
    options?: MessageSendOptions,
  ): Promise<void>;

  onAny(
    handler: (context: {
      session: S;
      message: SessionMessage;
    }) => void | Promise<void>,
  ): () => void;

  onSessionClosed(
    handler: (
      session: S,
      options?: { recoverable?: boolean },
    ) => void,
  ): () => void;
}
```

`send()` 只有在底层传输已接受序列化消息并准备发送后才能 resolve，不能仅因为消息放入本地队列就 resolve。

`onSessionClosed` 取消待处理请求和处理器生命周期，默认永久淘汰会话对象。如果只是暂时撤回访问且仍将复用同一会话，例如重连期间的信任验证，应使用 `{ recoverable: true }`。新工作获得新的请求生命周期；访问恢复前，传输仍须执行权限限制。被中断生命周期中迟到的处理器结果不得发送响应。

通用协议状态机随后可运行在任意客户端自定义的会话对象上：

```ts
const protocol = new P2PProtocol(myTransport);

const session = {
  clientId: "device-a",
  targetClientId: "device-b",
  nativeHandle: 42,
};

await protocol.call(session, "send-text", {
  data: "hello",
});
```

浏览器通过 `application/rtc/rtc-service.ts` 适配 `PeerSession`。WebRTC DataChannel 发送队列位于会话适配器旁的 `domain/session-send-queue.ts`，有意不纳入可移植协议包。

## 消息封装 {#wire-envelope}

每条控制消息都是 JSON，使用相同的基础 envelope：

```json
{
  "id": "message-id",
  "type": "send-text",
  "createdAt": 1760000000000,
  "client": "sender-client-id",
  "target": "receiver-client-id"
}
```

必填基础字段：

| 字段        | 类型   | 含义                               |
| ----------- | ------ | ---------------------------------- |
| `id`        | string | 稳定的请求、消息身份，重试时复用。 |
| `type`      | string | 消息类型判别值。                   |
| `createdAt` | number | 发送方生成的毫秒时间戳。           |
| `client`    | string | 发送方 client ID。                 |
| `target`    | string | 目标接收方 client ID。             |

`sending`、`received`、进度或持久化状态等本地 UI 数据**不属于**线上协议，它们属于各客户端的本地消息模型。

Envelope 拒绝保留的本地字段 `conversationId`、`room`、`deliveries`、`roomTransfers`、`localSequence`、`lastReadSequence`。本地到达顺序和已读游标由接收浏览器维护。私聊 `send-text` 不能附带这些字段，在投影到历史时绕过房间能力和绑定校验。

权威 TypeScript 线上 DTO 和请求策略位于 `domain/protocol/messages.ts`，运行时验证位于 `domain/protocol/validation.ts`。

## 共享 peer 能力 {#shared-peer-capabilities}

主消息通道打开时，双方各发送一次 `peer-capabilities` 通知。`version: 1` 标识能力同步 envelope，`revision` 仅为状态序号。首次 `update` 是完整快照：

```ts
{
  type: "peer-capabilities",
  version: 1,
  // Standard id, createdAt, client and target fields omitted.
  update: {
    kind: "snapshot",
    generation: "connection-id",
    revision: 1,
    services: {
      "messaging/1": {},
      "files/1": { content: true, shared: true },
      "room/1": { chat: true, files: true },
      "screen/1": { decode: { video: null, audio: null }, trickleIce: true, multiScreen: true },
      "control/1": { request: true, host: true, occupancy: { state: "idle" } },
      "clipboard/1": { inlineText: true },
      "fileDrop/1": {},
      "speedTest/1": { busy: false },
    },
  },
}
```

`services` 是开放的**服务名 / 协议主版本**映射，例如 `acme.whiteboard/1`。兼容的可选字段保留同一主版本，不兼容变化使用新键。每个声明的主版本都必须有已实现处理器。本版本内置功能各只实现 `/1`，没有不带版本的回退。现有载荷格式判别值，例如存储分页版本 3，属于 `files/1` 契约的一部分，不是额外可协商的功能实现。

双方从首次交换中选择已实现的最高共同主版本，无需单独协商 RPC。选择结果在当前 peer 连接内固定，更新可以撤回该版本，但不能把活动操作切换到另一个处理器。重连重新选择。未来支持多个主版本的发布必须注册实际实现，并在连接期间保持已实现版本集合稳定；仅声明旧主版本不等于提供兼容性。

线上 envelope 校验有界对象，不解释未知主版本载荷。只有已经协商且实现的主版本才运行其描述符验证器。未知版本或无效描述符只禁用对应功能，其他功能保留。使用方通过 `control` 等名称接收已协商描述符的类型化映射，原始带版本 offer 留在发现状态。
`PeerCapabilitiesService.protocol(session, service)` 返回准确的已选处理器 ID；不可用、无效或已撤回时返回 `undefined`。扩展分发使用该 ID，不从载荷推测版本。未知扩展名称无需修改同步格式即可声明、协商，扩展自行提供处理器和载荷校验。

消息发送、接收边界执行已协商功能要求。聊天、文件传输、房间聊天、原生屏幕、控制、剪贴板、文件拖放和测速各有独立门控。房间文件额外要求 `files`，远程剪贴板和拖放要求 `control`。控制协议不兼容不影响屏幕观看，文件协议不兼容不影响私聊或房间文本。按钮使用同一协商状态。
已经授权的请求仍可收到响应，让操作在能力撤回后结束。二进制传输保留已注册操作身份；能力声明不能授权未请求的通道或数据。

能力同步 envelope 有独立主版本。未知同步主版本不会按版本 1 解释：该传输的发现结果变为不可用，但不因此断开 peer，也不阻塞基础资料、流元数据。未来支持新同步主版本也需要真实 envelope 实现。增加功能通常无需更改同步 envelope。

服务键以字母开头，可含字母、数字、`.`、`_`、`/`、`-`，最多 128 个字符；`constructor` 和 `prototype` 为保留名称。可协商键以正的安全整数主版本结尾，不能带前导零。

发现完成后，仅发送 `kind: "patch"` 的变化条目。包含的每项替换该服务整个值，省略的服务保持不变，`null` 显式移除服务。例如以下补丁更新占用状态并移除扩展，不重发文件、编解码器或房间能力：

```ts
{
  kind: "patch",
  generation: "connection-id",
  revision: 12,
  services: {
    "control/1": {
      request: true,
      host: true,
      occupancy: { state: "controlled", clientId: "viewer", sourceId: "display" },
    },
    "acme.whiteboard/1": null,
  },
}
```

首次快照前，远端支持情况未知。合并状态中缺少某服务表示不支持。使用方等待发现或禁用操作，不通过打开数据通道探测。文件、资料和房间消息不再携带功能列表。媒体通道使用 DataChannel open 事件与共享能力，没有单独的媒体 `hello`。

声明作用于实际 peer 会话，校验双方 peer ID 和首次接受的 generation。每次声明递增发送方 revision，接收方**按服务**跟踪最新 revision。因此不同服务的较旧补丁仍生效，同一服务的过期替换或撤回被忽略。快照为所有省略键建立“不存在”基线，同时保留被更新补丁修改的条目。首次快照前到达的补丁缓冲等待，不向使用方暴露部分发现结果。

断开会清除发现、取消等待者与排队声明，下次打开发送完整快照。发送尚未完成时合并本地变化，补丁相对于最近成功发送状态计算。普通更新无需回执或发现 RPC。发送失败时以完整快照重试。

合并状态最多 32 个服务，声明最多 16 KiB。补丁可包含最多 64 项，以同时添加和撤回来替换整个集合；超大的补丁回退为完整快照。接收方最多保留 128 个条目 revision，包括撤回和首次发现前的更新。合并状态或保留历史超限时，发现变为未知，并发送 `update: { kind: "request-snapshot" }` 恢复完整基线。需要时持续重试恢复请求，恢复或断开时取消。新能力复用此模型，不增加发现握手。带版本服务条目独立更新、撤回，修改 `control/2` 不覆盖 `control/1`。

控制发现按 peer 独立计算。远程控制公开设置默认开启，未知客户端可以发现 `control/1` 并请求本地同意；关闭后仅标为 `allow` 的客户端可发现，并保留自动批准，未知客户端不收到控制条目。标为 `deny` 的客户端在两种模式下都隐藏。开关和 allow/deny 记录属于本地持久策略，存储的 `remoteControlWhitelistOnly` 与公开开关互为反值。
列表变化使用现有能力发布器：新增只替换 `control/1`，撤回发送 `control/1: null`，未变化 peer 不收到更新。首次发现始终反映当前策略。

隐藏的控制请求在排队或调用处理器之前静默丢弃，包括发现尚未完成时。撤回权限会取消待处理同意、移除原生控制绑定并撤销活动授权，不影响屏幕观看、消息或其他独立功能。

被控主机统一管理所有屏幕的占用状态。空闲时，多个客户端可以并发请求控制，未答复的同意请求不预留占用。主机可批准任一排队请求；选中时原子使其他同意 token 失效并拒绝其请求，包括头像共享流程中的请求。拒绝、取消或使某个未答复请求过期，不影响其他请求。

`pending` 表示已选中控制者，正在采集或执行原生授权，会阻止竞争请求。`controlled` 也会阻止请求，除非主机对该接收者明确声明 `takeover: true`。状态发布器广播选择、取消、撤销和释放，新连接客户端立即收到当前占用。头像流程从批准直到采集和原生交接完成期间预留占用，过期或取消会清除。
Pending 所有者可完成交接；其他观看者保留控制操作，但主机报告 `idle` 或允许接管前不可点击。屏幕块与头像请求遵循相同规则，头像接管复用当前来源并经过原生授权。UI 外也由请求守卫执行约束，原生仲裁处理同时请求。占用更新不重新协商媒体，也不替换现有输入授权。

`controlled` 加上匹配的 client、source 标识公开所有者。可选 `controllerKind: "remote" | "automation"` 标识授权类型，`automationActive: boolean` 标识当前自动化使用，包括借用手动授权。主机向所有观察者发送两者。旧 peer 缺少这些字段仍有效，但这些字段或猜测类型都不代表接管权限；控制标签与图标直接使用它们，不依赖本地控制者信息。
公开状态不是输入凭据：只有请求方收到绑定其连接、来源、媒体和几何的原生 grant，确认激活后才开始输入。Grant ID 和输入 epoch 从不进入公开快照。能力声明也不能替代房间 token、文件访问检查、剪贴板 grant 或测速同意。测速在打开数据通道前检查 busy，接收方仍负责仲裁并发启动。

小型远程剪贴板纯文本、富文本使用一个 `remote-clipboard` 请求，包含 `action: "inline"`、方向、operation/grant ID 和 `{type, data}` 条目。编码后的条目数组最多 8 KiB，最多三种不重复文本格式。更大文本、图片和文件使用现有有界二进制通道。粘贴须等原生剪贴板应用后才完成；复制选区仍先准备原生剪贴板序列，再注入 Ctrl+C。重试、取消和撤销保留相同 grant、operation 校验。

## 请求类型与 ACK 策略 {#request-types-and-ack-policy}

请求策略由 `requestSpec` 统一定义：

| 请求                  | 响应行为                                                           |
| --------------------- | ------------------------------------------------------------------ |
| `send-text`           | `ack`，mode 为 `receive`                                           |
| `room-capabilities`   | `ack`，mode 为 `receive`                                           |
| `send-room-text`      | `ack`，mode 为 `receive`                                           |
| `send-room-file`      | 内容 offer 使用 `file-offer-result`，否则为 `receive` 模式的 `ack` |
| `request-room-file`   | `ack`，mode 为 `send`                                              |
| `send-clipboard`      | `ack`，mode 为 `receive`                                           |
| `send-file`           | 内容 offer 使用 `file-offer-result`，否则为 `receive` 模式的 `ack` |
| `request-file`        | `ack`，mode 为 `send`                                              |
| `request-shared-file` | `ack`，mode 为 `send`                                              |
| `resume-file`         | `ack`，mode 为 `receive`                                           |
| `request-storage`     | `storage` 响应                                                     |

类型化结果直接完成原请求，不是反向请求，不再接收额外 ACK。结果丢失时复用原请求 ID 重试，接收方重放缓存结果，不重复运行处理器。文件 offer 结果只确认接受或复用，不表示二进制传输完成。

ACK 表示接收方请求处理器成功完成。可移植协议本身不保证持久存储、文件传输完成、剪贴板权限，也不表示人已阅读消息。

浏览器私聊与房间聊天处理器额外等待本地 IndexedDB 写入后再返回。回执确认当时本地持久化成功，不是已读回执、不代表服务器历史，也不保证用户删除浏览器数据后仍保留。

典型用法：

```ts
const receipt = await protocol.call(session, "send-text", {
  data: "Hello",
});

const page = await protocol.call(
  session,
  "request-storage",
  {
    pageIndex: 0,
    pageSize: 25,
    search: "report",
    sort: [{ field: "fileName", desc: false }],
  },
);

const stopHandling = protocol.handle(
  "request-storage",
  async ({ session, message, signal }) => {
    // Apply local authorization/policy here.
    return {
      items: [],
      totalCount: 0,
      pageIndex: 0,
      pageSize: message.pageSize,
      sharingEnabled: false,
    };
  },
);
```

`request-storage` 返回 `StoragePage`，不是元数据数组，也不暴露浏览器 `File`、IndexedDB 记录或缓存实现。

### 在线房间文本聊天，版本 1 {#online-room-text-chat-version-1}

`room-capabilities` 和 `send-room-text` 要求 `P2P_ROOM_CHAT_PROTOCOL_VERSION`，当前为 1。它们使用现有点对点控制 DataChannel，`client`、`target` 始终为实际会话双方 ID。信令协议、presence 和私聊 `send-text` envelope 不变。私聊与房间文本共用非空白校验及 65,536 个 UTF-16 code unit 上限。不得将不支持的房间消息变成私聊消息。

消息通道就绪后，双方发送含 `{ roomId, token }` 的 `room-capabilities`。Token 对当前本地房间、通道绑定全新生成。Peer 只确认属于其活动房间及实际会话的 offer。收到对方 token 且自己的 offer 获 ACK 后，才视为支持。后续传入 offer 可重启失败的首次协商，容纳双方房间初始化时序差异。版本缺失、不支持或无法完成协商的 peer 不算支持房间聊天。
即使无序通道先送达 ACK，浏览器也等待双方两部分齐备。协商等待有界，房间、通道绑定结束时取消。明确声明支持房间聊天的 peer 在握手失败后，会在活动连接上指数退避重试，从 1 秒到最多 10 秒；迟到的能力可用也会重启协商。成功、能力撤回、退出房间或通道替换时停止恢复，绝不复用退休绑定。未声明支持的 peer 保留有界兼容探测。

`send-room-text` 携带：

```ts
{
  roomId: string;
  senderToken: string;
  recipientToken: string;
  senderName: string;
  senderAvatar: string | null;
  data: string;
}
```

Room ID 非空，最多 256 个 UTF-16 code unit；绑定 token 最多 128。名称最多 128，头像最多 256 Ki，非空白文本最多 64 Ki UTF-16 code unit。接收方在写历史前验证双方绑定 token、活动房间和会话身份。会话替换、房间变化和通道关闭淘汰旧绑定。名称、头像是发送方提供的显示快照，不是独立身份认证。
浏览器房间文本请求发送 `senderAvatar: null`，peer 头像通过单独资料交换提供。本地历史可以保留自己的头像，但每个文本帧不重复携带可能很大的 base64 图片。字符上限不能覆盖传输协商的最大消息大小，传输拒绝仍显示为该接收者交付失败。

浏览器发送方保存一条逻辑消息，并快照发送时通道就绪的 peer。每个接收者副本共用消息 ID、发送方和创建时间，各自拥有 `sending` / `delivered` / `failed` / `unsupported` 状态，一个 ACK 不能完成整个群组。Fan-out 使用有界并发，一个 peer 失败不阻止其他接收者。手动重试仅针对原先失败且当前仍连接同一房间的 peer。替代会话使用新绑定 token，同时保留逻辑消息 ID、时间和内容。

没有离线发件箱、晚加入历史传输、服务器消息归档，或向新成员自动重放。历史和分类标签属于本地浏览器。会话 ID 在本地包含信令命名空间和 room ID，命名空间不作为认证声明发送。应用 store 持久去重匹配的逻辑房间消息，拒绝冲突 ID，补充协议有界、会话本地请求缓存，但不提供全局有序历史或跨设备 exactly-once 交付。

### 房间文件 offer 与显式下载，版本 1 {#room-file-offers-and-explicit-downloads-version-1}

房间文本与能力 envelope 保持版本 1。共享 peer 快照通过 `services.room.files` 声明房间文件支持；房间握手仍将请求绑定到当前房间 token。仅有房间 ACK 不代表支持文件。不支持的房间 offer 不会转为私聊消息。用户显式本地转发会以新 file ID 创建新的私聊副本，原房间附件仍只作用于房间。

`send-room-file` 使用 `P2P_ROOM_FILE_PROTOCOL_VERSION`，当前为 1。载荷包含 `roomId`、`senderToken`、`recipientToken`、`senderName`、`senderAvatar`、`fid`、`fileName`、`fileSize`、`chunkSize`，以及可选 `mimeType` / `lastModified`。只接受这些字段与标准 envelope，offer 不含文件字节。文件名为 1–1024 个 UTF-16 code unit，MIME 最多 255；文件大小为非负安全整数，分块大小为正安全整数。房间、token 和资料上限与文本相同。
接收方先持久保存 offer 再 ACK，ACK 只表示元数据已接收，不表示已下载。接收者可逐房间在本地启用小文件自动下载，使用传输设置的应用级大小上限，默认 5 MiB，每个房间默认关闭。它与手动下载使用同一 `request-room-file` 流程，不改协议，也不重放历史 offer。重复回执、已暂停或失败的传输不会自动启动新请求。

显式下载使用版本 1 的 `request-room-file`，包含房间、当前绑定 token、`offerId`、`fid`、`resume` 和可选分块 `ranges`，不重复文件元数据，以已授权原 offer 和提供方缓存为准。协议边界验证范围结构，应用再按已授权文件实际分块数验证边界。Offer ID 必须不同于请求 envelope ID。每次新下载、续传使用新请求 ID，传输重试复用同一请求。复用已完成请求的 ID、时间可能只重放缓存 ACK，不启动新传输。`send` ACK 确认下载建立，不表示二进制完成。

双方验证当前房间、会话与绑定 token。提供方还验证存储 offer 的发送者、房间命名空间、文件身份和原接收者快照。房间专用附件不能通过旧 `request-file` / `resume-file` 入口绕过检查。重连需新绑定 token 和新下载请求；保存 offer 不保证提供方在线或文件仍可用。

房间文件和文本共用本地历史及逐接收者 offer 交付状态。发送方逐 peer 传输状态、进度单独保存在本地 `roomTransfers`，线上拒绝此字段。回执与传输写入按逻辑消息串行。重复文件 offer ID 必须保留相同发送者、作用域、时间戳、文件身份和元数据。重新加载将中断交付标为失败、活动逐 peer 传输标为暂停；从未下载的 offer 不会仅因加载而变成暂停传输。

### 共享目录契约，版本 3 {#shared-directory-contract-version-3}

`request-storage` 和 `storage` 要求 `version: 3`，由消息工厂提供。浏览、获取前，peer 在共享快照声明 `services.files.shared`。早期目录版本及完整缓存响应被拒绝；报告不支持的 peer，不回退为枚举缓存。二进制数据协议和信令不变。

查询载荷：

```ts
type StorageQuery = {
  pageIndex: number; // zero-based non-negative safe integer
  pageSize: number; // integer in [1, 100]
  search?: string; // at most 256 UTF-16 code units
  sort?: {
    field:
      | "fileName"
      | "fileSize"
      | "createdAt"
      | "lastModified"
      | "mimetype";
    desc: boolean;
  }[];
};
```

提供方先过滤**整个可见目录**，再排序与切片。搜索以文件名子串匹配，比较双方都做 NFKC 规范化、去除首尾空白并转小写。按请求的字段顺序排序，未指定时默认文件名升序。文本排序键使用相同规范化，数值字段按数值比较，可选缺失值按零或空字符串处理。最终以 file ID 升序稳定打破平局，采用 code-unit 比较而非 locale 排序。拒绝重复、未知排序字段。

`storage.data` 响应：

```ts
type StoragePage = {
  items: ProtocolFileMetadata[];
  totalCount: number; // matches after search, before slicing
  pageIndex: number; // actual page, clamped to the last valid page
  pageSize: number;
  sharingEnabled: boolean;
};
```

空目录或拒绝访问时，items、count 都为零，page index 为零。拒绝响应的 `sharingEnabled: false`，不暴露底层数量。每次请求重新检查逐 peer 的 `provideFileList`；它同时授权目录下载，关闭时停止该成员活动的目录上传。显式聊天附件授权仍独立。

只有完整、已验证且本地开启共享的内容才进入索引，每个内容身份一项。ID 指向独立共享引用，不使用原私聊或房间附件 ID，每项包含 BLAKE3 指纹。显式 DTO 投影排除 `file`、`chunkCount`、`isComplete`、`isShared`、`isMerging`。
浏览器索引由已提交缓存事件更新，分页查询不刷新或扫描所有 IndexedDB 文件数据库。查询时 CPU 仍需过滤、排序内存元数据索引；这不是持久数据库分页索引。

### 共享文件下载 {#shared-file-downloads}

版本 1 的 `request-shared-file` 携带 `fid`，即共享引用，`fingerprint`、`chunkSize`、`transferId`，即用于本地接收存储的新 `shared-transfer_` UUID，可选包含两端的 `ranges`，以及 `have`。`have: true` 检查当前授权而不打开二进制通道，以复用已验证本地内容。缓存未命中时仅发送 `have: false`，把授权与发送方准备合为一次请求，不先用 `have: true` 探测。接收方收到响应后才创建二进制通道。已验证本地副本或跟随现有下载也仍需授权。
对于 `have: false`，提供方创建只读传输别名，对共享内容验证请求并确认建立。二进制通道使用 `<transferId>-0`。新尝试和续传使用新的控制请求 ID，续传任务保留 transfer ID 和缓存分块。

枚举和获取都要求当前已连接成员会话与权限，获取还验证共享引用、指纹和分块大小。取消共享或删除内容会终止对应目录上传。未知 ID、房间附件 ID、私聊引用 ID 都不能作为共享 ID。旧 `request-file` 必须匹配发给该 peer 的私聊消息，`resume-file` 必须匹配来自该 peer 的私聊消息，均不能任意获取缓存。共享下载在接收方创建任务与本地文件库引用，双方都不产生聊天消息。

### 目录失效通知 {#directory-invalidation}

`storage-changed` 是只有 envelope 的通知，**没有载荷**，不包含文件 ID、元数据、增量、数量、revision 或共享状态。接收方使活动查询失效，按原分页大小、搜索和排序重新请求当前页。不得发送未经请求的 `storage` 响应。

提供方在 100 ms 内合并可见目录变化，不发布分块进度。只通知已就绪且有文件列表权限的 peer。共享策略变化也发送一次空失效通知，包括关闭访问时；之后隐藏目录变化不再通知该 peer。

`FileCatalogService` 管理提供方、通知生命周期。`RemoteFileCatalog` 协调一个活动页：并发失效合并，请求期间的变化触发后续查询，被取代查询的响应丢弃，查询变化或销毁取消待处理工作。请求沿用标准协议发送、响应截止时间。失败保留明确的 stale/error 状态，用户刷新、后续通知或重连可以重试。通知自身没有回执或持久交付保证。

浏览器目录视图只在当前路由精确为对应 peer 的 `/client/:id/sync`，允许末尾斜杠，且 peer 在线、消息通道就绪时取页。离开路由或失去连接会移除视图订阅并取消待处理工作，即使组件仍挂载。其他位置收到通知不触发目录查询。重开视图或恢复连接总是请求新页。
断线 peer 显示空状态，不显示旧表格；标题的客户端设置入口仍可用。刷新位于表格“视图”控件旁。TanStack Table 使用 `manualPagination`、`manualFiltering`、`manualSorting` 和远端 `rowCount` 控制分页、搜索、排序，不对返回页再次切片或排序。搜索输入防抖 250 ms，搜索、排序或分页大小变化重置为第零页。提供方钳制后的页码应用到受控分页，不重复查询。本地下载状态只是显示列，不是远端查询过滤器。

## 通知 {#notifications}

通知不等待远端 ACK：

- `client-profile`
- `stream-state`
- `read-text`
- `storage-changed`，只有 envelope 的目录失效通知

```ts
await protocol.notify(session, "client-profile", {
  profile: {
    name: "Alice",
    avatar: null,
  },
});

await protocol.notify(session, "stream-state", {
  mode: "media",
  videoSources: [
    { mid: "0", kind: "camera" },
    { mid: "2", kind: "screen" },
  ],
  audioSources: [
    { mid: "1", kind: "microphone" },
    { mid: "3", kind: "screen", videoMid: "2" },
  ],
});
```

`stream-state` 携带完整视频、音频来源快照，两个数组均必填，空时也必须提供。`videoSources` 将每条已发布视频 transceiver 协商的 RTP `mid` 映射到 `camera` 或 `screen`；`audioSources` 标识每个麦克风 MID，或把共享音频 MID 关联到所属屏幕的 `videoMid`。音频 MID 只能出现一次，也不能同时是视频 MID；每个共享音频所有者必须在同一视频快照中以屏幕出现。
接收方独立记录每条本地接收轨道的 `RTCTrackEvent.transceiver.mid`，通过 MID 合并两种视图，不以 `MediaStreamTrack.id` 作为线上身份。这使参与者、头像及麦克风所有权与共享屏幕块分离，不依赖轨道标签或事件顺序。音视频轨道仍通过已协商的 RTP transceiver 传输。参与者可同时发布多条视频轨道，接收方汇总所有信令流的轨道，包括没有 stream 的轨道。
移除一个来源只重新协商变化的发送器。各 peer 连接借用本地采集轨道，仅应用采集所有者能停止它们，因此关闭某个 peer 或屏幕不会停止其他发布。

呈现流将麦克风音频附加到参与者摄像头、头像，将每个显示器音频附加到对应屏幕块。单块静音只影响该来源；成员静音作用于该成员所有当前和未来来源。成员静音后再取消某块静音，只启用这一块。全局播放静音保持独立。渲染和来源静音不会停止采集轨道，也不会在多个视频元素重复播放同一音频。

`client-profile` 通知携带 `P2P_PROFILE_PROTOCOL_VERSION`，当前为 1。历史名称 `RTC_PROFILE_PROTOCOL_VERSION` 作为别名保留。资料版本属于线上协议，资料归一化和 UI 占位属于本地客户端策略。

## 文件控制 DTO {#file-control-dtos}

文件控制消息只携带元数据，实际字节通过单独的文件传输协议发送。

`send-file` 和 `request-file` 使用：

- `fid`：逻辑文件 ID
- `fileName`
- `fileSize`
- 可选 `mimeType`
- 可选 `lastModified`
- `chunkSize`

`request-file` 还携带：

- `resume`
- 可选分块范围，每项为一个数字索引或包含两端的 `[start, end]`

`storage.data.items` 使用带 `mimetype` 的可移植元数据。浏览器专用的 `File`、缓存句柄或传输进度绝不属于控制协议。

## 超时、取消与重试 {#timeouts-cancellation-and-retries}

| 选项            |    默认值 | 含义                           |
| --------------- | --------: | ------------------------------ |
| `sendTimeoutMs` | 10,000 ms | 等待传输接受发送的最长时间。   |
| `timeoutMs`     |  5,000 ms | 发送成功后的响应截止时间。     |
| `retries`       |         0 | 响应超时后的额外尝试次数。     |
| `retryDelayMs`  |    250 ms | 下一次尝试前的等待时间。       |
| `signal`        |        无 | 取消发送等待、响应等待及重试。 |

应用消息 store **不再**拥有第二套发送超时，请求生命周期只由 P2P 协议负责。

尚未发送就过期或取消的请求，不能在传输恢复后迟到发送。消息已经发送后，取消无法撤销远端操作。

重试精确保留同一份冻结载荷、ID 和时间戳。

## 去重与会话生命周期 {#deduplication-and-session-lifetime}

请求作用于实际本地会话句柄，不按 ID 全局生效。

成功请求结果保留在有界内存去重缓存中：

- TTL：`PROTOCOL_DEDUP_TTL_MS`，10 分钟
- 最大条目数：`PROTOCOL_DEDUP_MAX_ENTRIES`，512

已完成请求重复到达时重放缓存响应，不重跑处理器。第一个处理器仍运行时收到重复请求，也不启动第二个处理器。

这不是持久的 exactly-once 交付。重新加载、新会话、去重过期或进程重启都可能让操作再次执行。

关闭会话立即拒绝待处理调用、中止处理器生命周期并淘汰会话句柄。属于退休会话的响应不能完成替代会话的调用。

## 错误 {#errors}

协议错误统一使用可移植协议模块导出的 `P2PProtocolError` 和 `P2PProtocolErrorCode`。

错误码：

- `already-pending`
- `timeout`
- `send-timeout`
- `aborted`
- `closed`
- `remote-error`
- `send-failed`
- `invalid-message`

无效超时或重试配置抛出 `RangeError`。

## 验证与信任边界 {#validation-and-trust-boundary}

所有传入网络控制数据在运行处理器前必须通过 `validateSessionMessage()` / `parseSessionMessage()`。

验证包括：

- envelope ID 与时间戳
- 发送方、目标身份是否匹配所属会话
- 消息专用载荷
- 文件数值元数据
- 分块范围
- client-profile 结构与版本
- 存储元数据

协议在重试前快照传出请求数据，调用者不能在首次尝试后改变载荷。

## Weblink 应用集成 {#weblink-application-integration}

可移植状态机没有聊天历史或 IndexedDB 概念。

Weblink 在协议上层添加这些职责：

- `application/messaging/conversation-messaging-service.ts` 提供共享的会话范围文本、文件提交与重试接口。提交在本地持久接受后 resolve，网络完成单独暴露；完成状态反映已持久化的接收者结果，包括房间部分失败。接受前失败不创建消息，之后交付失败留在原消息上，重试保留身份。
- `application/messaging/peer-messaging-service.ts` 将跟踪的协议请求映射为持久消息历史，并处理私聊文本接收。私聊、房间接收方都先持久化再 ACK。失败写入不缓存为成功请求，可以重试。同一身份下内容冲突的文本请求被拒绝，包括缓存请求重放。
- `application/messaging/room-messaging-service.ts` 管理房间能力协商、绑定生命周期、接收者快照和逐 peer 回执。
- `application/messaging/message-store.ts` 管理响应式聊天、文件历史。
- `application/messaging/conversation-message-store.ts` 管理共享持久插入、重复身份检查及有序回执、进度写入。重新加载中断的私聊、房间交付变为可重试失败，不自动离线重放。元数据交付与二进制文件完成分别处理。
- `application/messaging/message-repository.ts` 是持久化端口。
- `infrastructure/storage/indexeddb-message-repository.ts` 是浏览器持久化适配器。
- `application/rtc/rtc-service.ts` 将浏览器 `PeerSession` 事件适配到 `ProtocolTransport<PeerSession>`。
- `application/rtc/rtc-protocol.ts` 仅作为可移植 `P2PProtocol` 的 Weblink 组合、工厂封装。

## 模块所有权 {#module-ownership}

可移植协议包：

- `domain/protocol/index.ts`：公开导出接口。
- `domain/protocol/messages.ts`：完整线上 DTO 和请求、ACK 策略。
- `domain/protocol/validation.ts`：网络验证与不可变快照。
- `domain/protocol/errors.ts`：可移植错误和调用选项。
- `domain/protocol/transport.ts`：最小会话、传输端口。
- `domain/protocol/request-manager.ts`：待处理调用、响应匹配、去重和清理。
- `domain/protocol/protocol.ts`：通用 `P2PProtocol` 外观接口。
- `domain/protocol/constants.ts`：协议拥有的限制。

WebRTC 适配器：

- `domain/session-send-queue.ts`：浏览器 DataChannel 队列，不属于可移植协议。
- `application/rtc/rtc-service.ts`：PeerSession 传输适配器。
- `application/rtc/rtc-protocol.ts`：Weblink 单例组合。

## 跨客户端实现清单 {#cross-client-implementation-checklist}

非 Web 客户端应：

1. 使用相同 JSON 字段名和消息判别值。
2. 对照所属 peer 会话验证 `client` 和 `target`。
3. 重试期间保留请求 `id`、`createdAt` 和载荷。
4. 精确实现 `requestSpec` 定义的 ACK mode。
5. 将 `request-storage` 视为类型化响应流程，而非通用 ACK。
6. 在有界的会话本地缓存中去重已完成请求。
7. peer 会话关闭或替换时中止待处理调用。
8. 文件字节和测速流量留在控制消息流之外。
9. 本地消息、UI、持久化字段不进入线上 envelope。
10. 将信令作为独立的会合协议处理。

## 测试 {#testing}

协议单元、集成覆盖和真实 Chromium DataChannel 冒烟测试见[测试与验证](../development/testing.md)。可移植契约行为放在单元、集成测试中，浏览器 E2E 冒烟只用于依赖真实 RTCDataChannel 的行为。
