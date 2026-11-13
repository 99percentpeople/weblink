# 连接测速

客户端信息对话框中的“测速”页诊断的是**当前 WebRTC 连接**，不是通用互联网带宽。双方必须支持 `weblink-speedtest-v1` DataChannel 协议，且接收方同意后才会发送测试数据。测速不会创建测试文件或 IndexedDB 缓存记录。

## 所有权与生命周期 {#ownership-and-lifecycle}

- `apps/web/src/libs/domain/speed-test-protocol.ts` 定义消息、校验和限制。
- `apps/web/src/libs/domain/speed-test.ts` 实现有界的双向数据交换。
- `apps/web/src/libs/application/speed-test-service.ts` 同时只管理一项活动诊断，通过依赖注入接收 peer 连接、忙碌策略、同意回调和状态接收接口。
- `AppStateProvider` 拥有此服务。关闭对话框、切换目标或卸载视图不会取消操作；结果保存在应用任务服务的有界历史中。
- 点击停止、离开房间、销毁应用或连接丢失会取消测速。清理只关闭临时诊断通道，不关闭聊天、文件通道或 peer 连接。服务忙碌时拒绝新的传入诊断。

## 协议与限制 {#protocol-and-limits}

两个方向顺序复用一个临时、可靠、有序的 DataChannel，先由发起方上传，再下载。线上协议方向始终相对于发起方命名，UI 则在每一端归一化为本地上传与下载。

| 限制                  | 默认值 / 最大值                           |
| --------------------- | ----------------------------------------- |
| 每个方向的数据量      | 64 MiB                                    |
| 每个方向的发送时长    | 10 秒                                     |
| 数据块                | 最多 32 KiB，同时受 SCTP 最大消息大小限制 |
| 发送缓冲区高 / 低水位 | 256 KiB / 64 KiB                          |
| 等待同意              | 20 秒                                     |
| 握手                  | 5 秒                                      |
| 阶段超时              | 15 秒                                     |
| 总运行超时            | 60 秒                                     |

达到数据量上限或发送时长限制后，该方向停止发送，但仍需等待接收方返回匹配回执后才完成。**两个方向合计最多 128 MiB 测试数据**，不含控制消息和网络、协议开销。默认值定义在协议模块中，不在 UI 中。不支持测速的 peer 会超时，不会退回文件传输流程。

## 可移植的消息序列 {#portable-wire-sequence}

DataChannel 的版本化协议字符串为 `weblink-speedtest-v1`。通道必须可靠且有序，即 `ordered === true`、`maxRetransmits === null`、`maxPacketLifeTime === null`。未来不兼容的诊断格式必须使用不同的协议字符串。

控制帧是 JSON 字符串，由 `domain/speed-test-protocol.ts` 中的 `encodeSpeedTestMessage()` / `parseSpeedTestMessage()` 编码与解析。二进制 DataChannel 消息直接承载测试字节，没有额外数据包头。

初始同意握手如下：

```text
initiator -> receiver  { type: "hello", durationMs, maxBytes }
receiver  -> initiator { type: "offer" }
receiver performs local user approval
receiver  -> initiator { type: "ready" }
```

接收方也可以返回拒绝：

```json
{ "type": "reject", "reason": "busy" }
{ "type": "reject", "reason": "declined" }
```

之后，每个测量方向使用以下有序序列：

```text
sender   -> receiver { type: "start", direction }
receiver -> sender   { type: "go", direction }
sender   -> receiver { type: "begin", direction }
sender   -> receiver binary payload messages...
sender   -> receiver { type: "end", direction, bytes }
receiver -> sender   { type: "receipt", direction, bytes, durationMs }
```

方向名称始终相对于最初的发起方：

- `upload`：发起方发送数据，接收方测量。
- `download`：接收方发送数据，发起方测量。

接收方仅在收到匹配的 `begin` 后启动单调时钟计时，只统计 `end` 之前收到的二进制消息，并要求累计字节数与 `end.bytes` 完全一致。发送方只接受包含相同字节数的匹配回执。

兼容的非 Web 客户端应遵循以下规则：

1. 打开一个协议为 `weblink-speedtest-v1` 的临时、可靠、有序通道。
2. 在协议最大值范围内执行 `hello` 声明的限制。
3. 获得本地用户同意后才发送 `ready`。
4. 区分 JSON 控制帧与二进制数据消息。
5. 保持消息顺序；协议要求 `end` 在其前面的所有测试数据之后抵达。
6. 使用本地单调时钟测量，不要求双方时钟同步。
7. 接受结果前检查方向、字节数和回执时间。
8. 完成或取消时仅关闭临时诊断通道。

测速载荷有意使用随机字节，不压缩、不持久化，也不支持断点续传；这一点与文件传输不同。

## 测量含义 {#what-is-measured}

接收方统计二进制载荷字节数，以单调时钟测量有序 `begin` 与 `end` 标记之间的时长。回执包含字节数和耗时；发送方核对方向与数量后才接受结果，无需同步双方时钟。

最终吞吐量为 `receivedBytes * 1000 / durationMs`。UI 同时显示 Mbps，即十进制兆比特每秒，以及 MiB/s，即二进制兆字节每秒。实时表盘是进度估算，不能当作已确认的最终速率。

结果反映选定 ICE 路径上的应用层吞吐量，该路径可能经过 TURN。它包含浏览器调度、DataChannel 交付和网络争用的影响，但不包括文件压缩、磁盘写入或 IndexedDB 最终提交。过小或过短的测试、后台标签页、设备限速及其他流量都可能使结果失真。回环冒烟测试结果不能视为公网带宽基准。

## 测试 {#testing}

测速单元与集成覆盖、任务 UI 集成和真实 Chromium 诊断冒烟路径见[测试与验证](../development/testing.md)。

浏览器冒烟测试使用回环 peer 连接和隔离的 Chromium 配置。在宣称跨浏览器行为或用户网络吞吐量之前，仍需进行真实设备、真实网络以及后台、挂起场景的检查。
