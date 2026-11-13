# 常见问题

按实际遇到的现象查找。功能的设置方法见各篇使用指南；这里集中说明兼容性限制、连接失败和恢复办法。

## 浏览器与运行环境 {#browser}

### 页面能打开，但操作时报“is not a function”，是什么原因？ {#browser-api}

旧浏览器可能可以加载页面，却缺少后续操作所需的 JavaScript API。通过启动时的兼容性检查，也不代表所有功能都能正常使用。

| 控制台报错示例                                                   | 在 Weblink 中可能对应的原因                                     |
| ---------------------------------------------------------------- | --------------------------------------------------------------- |
| `findLast is not a function`                                     | 浏览器缺少 `Array.prototype.findLast()`，消息和附件处理会用到它 |
| `Intl.Segmenter is not a constructor` 或 `Intl.Segmenter` 未定义 | 浏览器缺少长消息预览所用的文本分段 API                          |

先升级到浏览器当前稳定版，完全重启后再试。如果通过其他应用的内置浏览器打开，请改用独立浏览器访问同一地址。桌面端还应更新 WebView2 运行时。更换信令服务器无法补上浏览器缺少的 API。

各 API 的支持情况见 MDN 的 [findLast](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Array/findLast#browser_compatibility) 和 [Intl.Segmenter](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter#browser_compatibility) 兼容性表。这些表不代表 Weblink 全部功能的最低版本保证。升级后仍出现问题，请在[反馈问题](#report)时提供完整浏览器版本和控制台第一条错误。

### 为什么这个浏览器没有采集或本地目录选项？ {#capture}

这些功能分别依赖不同的 API 和权限，能聊天或支持 WebRTC 不代表全部可用。

| 现象                                                     | 检查方法                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 摄像头、麦克风不可用，或 `navigator.mediaDevices` 不存在 | 使用 HTTPS 访问；本机测试可用 localhost。同时检查浏览器和系统的摄像头、麦克风权限                    |
| 无法共享屏幕                                             | 浏览器必须提供 `getDisplayMedia()`；不同浏览器与平台支持不同，手机和内置浏览器尤其需要确认           |
| 没有本地目录存储选项                                     | 浏览器必须在安全上下文中提供 `showDirectoryPicker()`；不可用时使用浏览器存储，再通过“保存到设备”导出 |

具体要求见 MDN 的[摄像头与麦克风采集](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)、[屏幕采集](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)和[目录选择](https://developer.mozilla.org/en-US/docs/Web/API/Window/showDirectoryPicker)说明。

局域网 IP 的 HTTP 页面不等同于 localhost。反复授权也不能补上浏览器未实现的 API。可以换用当前版本的桌面浏览器，或使用 Windows 桌面端的原生屏幕共享。

### 桌面端白屏或无法启动，应该检查什么？ {#desktop-start}

先核对[安装要求](desktop.md#install)：Windows 10 22H2 / Windows 11 x64，WebView2 120 或更新版本。应使用及时更新的 WebView2；列出的最低要求不保证每种媒体能力都可用。

安装器会在需要时安装或更新 WebView2；便携版或单独的可执行文件需要系统已安装运行时，便携 ZIP 必须先解压再运行。仍有问题时，提供 Weblink、Windows、WebView2 版本和启动错误。启动后的 JavaScript 报错按[浏览器 API 问题](#browser-api)检查。

## 信令与网络连接 {#connection}

### 在中国大陆加入房间很慢，或者无法连接，怎么办？ {#signaling-mainland}

默认信令地址为 `wss://ws.webl.ink`。在部分中国大陆网络中，信令端点可能连接缓慢、超时或反复重连。可达性与具体端点、运营商、DNS 和网络线路有关，某个网络能访问不代表其他网络也能访问。

1. 在**设置 → 连接 → WebSocket 信令服务器**确认实际使用的地址。已保存的自定义地址会覆盖站点或安装包默认值。
2. 在受影响设备上，对同一端点分别使用其他网络测试，例如 Wi-Fi 和移动数据。按[下方检查方法](#signaling-unreachable)记录问题发生在 DNS、TLS 还是 WebSocket 握手阶段。
3. 如果该端点持续不可达，改用**所有参与设备都能访问**的信令服务，或自建 [Server](../deployment/backend.md)、[Worker](../deployment/worker.md)。使用 Worker 或自定义域名本身并不保证大陆可达，仍需从实际使用的网络验证。
4. 所有设备改成相同的信令地址后重新加入房间。不同信令服务器上的相同房间 ID 不属于同一个房间。

信令负责房间发现和连接协商；消息、文件和媒体通过 WebRTC 直连或 TURN 中继传输。已经能看到成员后，传输或视频失败应继续检查 [WebRTC 连接](#peer-connection)，更换信令域名不一定改善这条数据通路。

### 网页能打开，但 WebSocket 一直连接失败，如何定位？ {#signaling-unreachable}

网页和信令服务可以部署在不同位置。打开浏览器开发者工具 → **Network（网络）→ WS**，重新加入房间，查看实际请求。

| 观察到的现象                             | 优先检查或处理                                                               |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| DNS 解析失败                             | 核对信令域名，以及这台设备的 DNS 和网络访问情况                              |
| 证书或混合内容错误                       | HTTPS 网页使用有效的 `wss://` 端点；检查证书、域名和设备时间                 |
| 握手超时或连接被拒绝                     | 检查服务是否运行、端口及防火墙是否放行，以及当前网络或代理是否允许 WebSocket |
| WebSocket 请求返回 HTTP 错误，未建立连接 | 核对 URL 路径、反向代理的 WebSocket 升级转发和后端日志                       |
| WebSocket 已连接，但看不到对方           | 比较两端完整信令地址、房间 ID、密码和在线状态                                |

自建 Server 或 Worker 时，若已对外提供该路由，可用 `https://signal.example.com/healthcheck` 检查 HTTP 可达性。返回 200 不能证明 WebSocket 升级或设备连接成功。反过来，在地址栏直接打开信令根地址可能返回 400 或 426，因为普通网页访问不是 WebSocket 握手。

使用客户端实际能访问的完整端点，包括配置的路径。另一台设备不能通过它自己的 `localhost` 或 Docker 内部服务名访问你的服务器。桌面安装版连接非回环地址也要求 WSS，包括局域网地址。代理配置见 [Server 反向代理设置](../deployment/backend.md#tls-and-proxy)。

重新构建后仍请求旧地址时，先更新或重置客户端已保存的连接设置，再重新加入房间。前端默认值在构建时写入，仅修改静态文件容器运行时的环境变量不会重新构建这些值。

### 能看到成员，但消息、文件或视频仍连不上，是什么原因？ {#peer-connection}

发现成员只说明信令已有进展，不代表 WebRTC 数据通路已建立。

1. 检查[配对和设备权限](device-trust.md#pairing)。身份警告或权限拒绝需要分别处理。
2. 在**设置 → 连接**中，从两端网络检查 STUN/TURN 可用性。信令 Server 或 Worker 不能代替 TURN 中继。
3. 如果开启了仅中继模式，必须有可达的 TURN 服务和有效凭据。没有时关闭该模式，重新连接以允许直连。
4. 换一个网络对比。防火墙或 NAT 阻止直连时，应配置两端都能访问的 TURN；只替换 WS 地址不会增加中继能力。

如果消息或文件已经正常，只有视频失败，继续看[编码与视频排查](#media)。传输慢时可对比[连接测速](connection.md#speed-test)和实际保存速度；磁盘写入、压缩、并行任务和设备负载不属于网络测速的测量范围。

### TURN 凭据请求返回 503、502、504，分别是什么意思？ {#turn-credentials}

这些响应属于 `/turn-credentials`，不是 WebSocket 连接本身的状态：

| 状态码 | 含义与处理                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------- |
| 503    | 未配置托管 TURN。服务管理者需要在后端同时设置 `TURN_KEY_ID` 和 `TURN_KEY_API_TOKEN`，然后重启或重新部署 |
| 502    | 后端未能从上游取得凭据，检查后端错误和上游访问情况                                                      |
| 504    | 上游请求超时，检查后端到服务商的连通性后重试                                                            |

未配置托管 TURN 时信令仍可工作，但需要中继的网络必须另有可用的 TURN 配置。服务商密钥只放在后端。即使 WebSocket 使用 `/ws`，凭据接口仍位于同源根路径 `/turn-credentials`；仓库附带的 Nginx 模板默认只代理 `/ws`。配置方法见 [Server TURN](../deployment/backend.md#turn) 或 [Worker TURN](../deployment/worker.md#turn)。

## 音频、视频与录制 {#media}

### 为什么 Chrome 能使用 H.265，Edge 发送或接收却失败？ {#hevc-browsers}

**WebRTC 发送编码、接收解码和文件播放是不同的能力。** 对这里讨论的 Chromium 内核桌面浏览器，已知的默认 WebRTC 支持情况如下：

| 浏览器         | 发送 H.265 / HEVC                                    | 接收 H.265 / HEVC                                       |
| -------------- | ---------------------------------------------------- | ------------------------------------------------------- |
| Chrome         | 从 Chrome 136 起支持，需要平台提供可用的 HEVC 编码器 | 从 Chrome 136 起支持，需要平台提供可用的 HEVC 解码器    |
| Microsoft Edge | 目前默认不支持                                       | 目前默认不支持，仅提供 H.265 的视频可能在协商阶段被拒绝 |

Chrome 的支持起点见 [Chrome 136 发布说明](https://developer.chrome.com/release-notes/136#h265_hevc_codec_support_in_webrtc)，平台条件见其 [WebRTC 实现说明](https://groups.google.com/a/chromium.org/g/blink-dev/c/3h8lL8a377c)。2026 年 5 月的 [Microsoft Q&A 支持回复](https://learn.microsoft.com/en-us/answers/questions/5880331/h-265-hevc-not-published-sent-via-webrtc-chrome-su)说明了 Edge 尚未默认启用发送和接收支持。资料核对日期为 **2026-11-12**，后续浏览器版本可能改变支持情况。

这也影响**作为观看端的 Edge**。Chrome 或原生桌面端能够发送 H.265，不代表 Edge 能接收。视频可能在协商阶段被拒绝，浏览器不一定立即抛出 JavaScript 异常；Weblink 的屏幕共享接收端会将这种拒绝判为视频格式不支持。

任一端使用 Edge 时，在**发送设备**上选择**自动**或可用的 H.264，再重新开始共享。自动模式会参考已连接接收端的能力。需要使用 H.265 时，发送端和接收端都必须提供对应的 WebRTC 能力。这里的桌面 Chrome 支持情况不能直接套用到 iOS 版 Chrome 或所有 Chromium 衍生浏览器。

Edge 能播放 HEVC 文件，或在其他媒体 API 中支持 HEVC，不代表能通过 WebRTC 发送或接收。Windows 上的 HEVC 播放另有[解码器要求](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/video-playback-issues)；安装播放解码器并不是补上 Edge 默认 WebRTC H.265 能力的已确认解决办法。

### 已经更新 Chrome，为什么仍没有 H.265，或者实际没有使用它？ {#hevc-unavailable}

浏览器版本只是条件之一，还要检查当前操作系统、GPU、驱动和浏览器硬件加速配置是否提供 HEVC 编码器。可以通过 Chrome 的 `chrome://gpu` 查看加速状态，但看到硬件能力不等于 WebRTC 已成功协商使用它。

Weblink 会综合本地编码能力和已连接设备的解码能力。自动模式优先选择共同支持的格式，设备加入或离开时，可选项可能变化。手动选择编码只是协商偏好，不保证每个接收端最终都使用该格式。

先用自动模式，或用 H.264 对比兼容性，再重新开始共享。必须使用 H.265 时，要同时检查发送端与接收端，不能只看发送端设置。Tauri 原生屏幕共享使用它检测到的原生编码器，不能直接套用 Edge 浏览器的限制。

### 画面正常，为什么听不到声音？ {#no-audio}

1. 先确认需要的是哪个声音来源。麦克风需要采集权限、正确的输入设备以及发送端取消静音；屏幕声音需要共享来源实际提供音频轨道，仅共享视频不会自动附带声音。
2. 在接收设备开启收听，并取消对应成员或来源的静音。同时检查网站或标签页静音、操作系统的应用音量，以及实际使用的耳机或扬声器。
3. 主动点击应用中的收听操作。浏览器自动播放策略可能阻止音频播放器；Windows 原生接收也需要 Web Audio 播放上下文正常运行。
4. 如果选中的输出设备已断开或不可用，在支持时选择可用设备，或恢复系统默认输出。
5. Windows 原生系统声音共享若开启了抑制本地播放，会静音活动播放端点，同时继续采集。需要本地收听时，应关闭此选项并重新开始系统声音共享。
6. 如果手动选择音频编码后才出现无声，恢复自动选项，再重新开启对应来源。

视频解码与声音播放是两项独立检查。[音频链路专题](../architecture/audio.md)说明了采集、解码与本地播放的边界；如果所有对端数据都不通，先进行[连接排查](#peer-connection)。

### 连接正常，但视频黑屏、只有声音或明显卡顿，怎么办？ {#video}

1. 先看发送端本地预览是否正常。本地已经黑屏时，重新选择采集来源并检查[采集权限](#capture)。
2. 切换到自动或可用的 H.264，重新开始共享。如果画面恢复，继续核对之前使用的编码和接收端解码支持，尤其是 H.265。
3. 降低分辨率、帧率和码率，检查设备负载与[当前连接速度](connection.md#speed-test)。直连或 TURN 中继通路拥塞都可能导致卡顿。
4. 如果仅某个观看端异常，对比它与正常观看端的浏览器、版本、GPU/驱动、网络和接收画质设置。

本地预览正常不能证明对方能解码传输中的视频。如果所有设备数据都无法连通，先回到[连接排查](#peer-connection)。

### 录制文件已保存完成，为什么还是无法播放？ {#recording-playback}

先确认文件确实保存完成。刷新、崩溃或未完成的传输可能留下不完整文件；暂停录制不等于停止并完成文件保存。

对完整文件，播放器必须同时支持容器和其中的视频、音频编码。**MP4 不一定是 H.264**，Weblink 可以将 H.265 原样保存在 MP4 录制文件中。选择容器或修改扩展名不能保证转换编码。

可换用支持实际编码的播放器。后续录制若需要更广的播放兼容性，可在来源端使用可用的 H.264，并先用一段短录制验证目标播放器。格式选择见[录制说明](media.md#recording)；Edge 的 HEVC 文件播放取决于其 [Windows 解码路径](https://learn.microsoft.com/en-us/troubleshoot/microsoft-edge/development/video-playback-issues)。

## 文件访问与保存 {#files}

### 原本可用的文件为什么突然读不到了？ {#file-unavailable}

目录中的文件先检查原件是否被移动、修改或删除，磁盘是否连接，以及浏览器是否需要重新授权目录。恢复[目录访问](storage.md#change-directory)后再重试。修改过的文件应重新发送，旧附件不会自动指向新内容。

浏览器存储中的文件还要确认是否在原来的站点和浏览器配置中访问。清除站点数据可能删除内容，不能用来修复文件缺失。附件条目还在，不代表源文件内容仍可读取。

### 接收文件或录制时，为什么在保存阶段失败？ {#storage-full}

检查保存位置、磁盘剩余空间或浏览器存储配额，以及目录写入权限。网络传输成功不代表目标位置一定能完成写入。

先把需要保留的文件保存到设备，再清理不需要的内容。浏览器支持时，可为**新任务**选择一个可写的本地目录；修改默认位置不会搬移正在进行的任务。不要把清空全部站点数据当成常规重试办法，其中还保存着历史记录和设置。参见[清理存储](storage.md#cleanup)。

## MCP 连接错误 {#mcp}

### MCP 客户端提示连接被拒绝，应该检查什么？ {#mcp-connection}

在桌面端确认**启用 MCP**已开启，端点正在运行。对照 Weblink 显示的当前地址检查客户端 URL、端口占用；局域网访问还要检查防火墙和监听地址。`127.0.0.1` 始终指向运行 MCP 客户端的那台电脑。

修改监听地址后，关闭并重新启用 MCP，再更新客户端配置。仅开启自动化不会启动监听器。浏览器使用 WebMCP，不提供本地 HTTP 端点。步骤见 [MCP 接入配置](automation.md#quick-start)。

### MCP 认证为什么被拒绝？ {#mcp-auth}

检查客户端是否向正确的桌面端点发送了生成配置中的 Authorization 请求头。Token 必须由该端点签发，且未过期、未撤销。完整 Token 丢失时需要新建并更新客户端，现有 Token 摘要无法恢复它。

如果认证已成功，但工具返回 `DISABLED` 或要求远端批准，应检查[自动化开关](automation.md#switches)和[目标设备权限](automation.md#permissions)，它们与 Token 认证分别生效。

## 反馈问题 {#report}

可复现的问题请提交到 [GitHub Issues](https://github.com/99percentpeople/weblink/issues)，说明操作步骤、预期与实际现象、Weblink 版本、完整浏览器或 WebView2 版本、系统版本。

连接问题附上信令域名和路径、受影响地区与运营商或网络类型、发生时间，并区分 DNS、TLS、WebSocket 和设备连接失败。视频问题说明双方版本、谁发送谁接收、所选编码、相关 GPU/驱动，以及自动模式或 H.264 是否正常。

分享日志前移除房间密码、MCP Token、TURN 凭据和私有网络信息。文件问题说明存储方式与失败阶段即可，无需上传私人文件。

## 接下来想了解什么？ {#next-steps}

- **问题解决后，想重新连接设备**：回到[连接两台设备](../index.md#connect-two-devices)。
- **想更换不可达的信令端点，或配置中继**：前往[连接设置](connection.md)。
- **想调整采集、编码或录制设置**：继续阅读[音视频与录制](media.md)。
- **想运行自己的信令服务，并从用户网络验证可达性**：选择 [Server 部署](../deployment/backend.md)或 [Worker 部署](../deployment/worker.md)。
