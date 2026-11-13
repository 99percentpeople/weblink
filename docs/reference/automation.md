# 自动化：WebMCP 与 MCP

Weblink 通过浏览器 WebMCP 和原生 MCP 服务器暴露同一工具目录。桌面端的**设置 → 自动化**具有两个独立开关：

- **启用自动化**：允许 MCP 客户端和已授权远程设备操作本机，不会启动 MCP API。
- **启用 MCP**：启动 MCP API。本地自动化关闭时，客户端仍可使用 `devices.list`、本地诊断及向直接连接设备转发调用；其他本地工具返回 `DISABLED`。传入操作系统自动化调用要求本地自动化开启，并满足目标设备既有权限。

桌面和浏览器默认都支持流诊断，不依赖上述开关或浏览器 WebMCP。已配对设备可通过现有 `automation/1` 通道调用 `diagnostics.snapshot`、`history`、`export`、`start`、`stop`。接收方的**读取与诊断**策略仍限制访问：询问采用会话批准，始终允许和拒绝按设备保存，仍检查信任、内容接收和连接代次。兼容新增的 `automation/1.diagnostics` 标记声明能力，不改变共享协议版本。

浏览器只有用于 WebMCP 注册的**启用 MCP**。它接受传入诊断，采用与桌面相同的设备权限、通知批准，拒绝所有传入操作系统自动化与转发。浏览器本地 WebMCP 客户端读取自己的诊断无需 peer 批准。

两个开关初始都关闭，分别持久化。原生启动等待 authority 通道后再恢复各开关。MCP 绑定失败会报告错误，不清除保存偏好，也不停止本地自动化。关闭自动化会取消本地操作系统调用、批准、命令任务和输入租约，保留诊断及 MCP 转发。关闭 MCP 会取消 token 调用并停止监听器，保留传入 peer 权限。应用运行期间，peer 诊断通道一直可用；HTTP MCP 监听和浏览器工具注册仍跟随 MCP 开关。

## 快速开始 {#quick-start}

### 桌面 MCP 客户端 {#desktop-mcp-client}

1. 在 Windows 桌面打开**设置 → 自动化**，启用 **MCP**。
2. 在**本地 MCP 令牌**中为客户端创建具名 token，选择有效期，从创建对话框复制秘密值或连接配置；完整秘密只显示一次。
3. 用生成的 URL 和 Authorization header 配置 MCP 客户端。默认监听器条目如下，外层配置格式可能因客户端而异：

   ```json
   {
     "url": "http://127.0.0.1:32100/mcp",
     "headers": {
       "Authorization": "Bearer <YOUR_MCP_TOKEN>"
     }
   }
   ```

4. 如果需要本机操作系统工具，再启用本机**自动化**。关闭自动化时仍可发现、诊断和转发，仅启用 MCP 不允许本地操作系统控制。
5. 让客户端列出设备。每个工具都要求显式 `target`：

   ```json
   {
     "name": "devices.list",
     "arguments": { "target": "local" }
   }
   ```

操作远程桌面时，先让两台 Weblink 设备加入同一房间，完成[设备配对](device-trust.md)。操作系统工具还需在目标启用自动化，使用 `devices.list` 返回的设备 ID 作为 `target`。目标的设备设置决定读取与诊断、共享与控制、终端与命令是否需要批准。通知批准在该连接内有效，始终允许、拒绝作为策略保存。Peer 调用不要求目标暴露自己的 HTTP MCP API。

指针或键盘输入可用 `screen.sources` 的显示器 `sourceId` 调用 `control.acquire`，一次完成共享准备和控制获取。已有活动原生显示器也可通过 `trackId` 获取。输入默认操作当前桌面，`control.bindWindow` 是可选项。截图可观察完整来源、窗口或矩形，指针坐标使用结果中的图片到桌面变换。选择 Shell 信号前先查询 `commands.capabilities`。

### 浏览器 WebMCP 客户端 {#browser-webmcp-client}

在提供 `document.modelContext` 的浏览器中，于自动化设置启用 **MCP**，连接已配对且开启自动化的桌面，并用该桌面 ID 作目标。如果只诊断，目标也可以是浏览器，且无需开启自动化或 MCP。浏览器向 WebMCP 注册共享工具，不启动 HTTP 监听、不签发本地 token，也不在本地执行操作系统输入或 Shell。缺少 WebMCP 时开关不可用。

## 连接配置 {#connecting}

支持的浏览器使用 [WebMCP `document.modelContext` API](https://webmachinelearning.github.io/webmcp/)。API 不可用时开关保持关闭、禁用，但不擦除保存偏好。工具注册成功后 MCP 才活动；注册失败、关闭 MCP 或关页都会中止注册。浏览器没有本地 token 管理，即使没有 WebMCP，也能通过设备权限和通知批准授权传入诊断。操作系统输入和 Shell 执行要求桌面目标。

桌面端在自动化设置为每个客户端创建独立 MCP 凭据，将显示的 Streamable HTTP URL 和 Authorization header 复制到客户端配置。生成配置直接发送 `Authorization: sk-...`，也接受 `Authorization: Bearer <token>`；两种形式执行相同到期、撤销、Host 和 Origin 检查。
**MCP 服务器**设置监听主机与端口，文本字段失焦自动保存，MCP 运行中也一样。监听修改在下次启用 MCP 时生效，此前保留当前端点、调用与授权；UI 区分活动 URL 和待应用设置。默认主机 `127.0.0.1`，接受 `localhost`、IPv4、IPv6 字面量；`0.0.0.0`、`::` 显式监听所有接口。
连接地址列表包含本地回环 URL 及对应监听地址族的活动网络接口具体 IP URL，均包含端口和 `/mcp`。网络接口变化时刷新，待应用的主机、端口编辑在监听器重启前不改变列表。其他电脑使用本机可达网络 IP，不使用回环地址。IPv6 链路本地地址因接口作用域取决于连接电脑而被省略。创建 token 默认仍用本地 URL，远端客户端从列表替换地址。服务使用 HTTP，不终止 TLS，也不提供 DNS 主机名别名。
默认端口 `32100`，有效范围 1–65535，拒绝 `0`。恢复默认设为 `127.0.0.1:32100`，同样延后应用。主机、端口跨重启保存。端口冲突是明确启动错误，不会静默更换保存端口。修改端点保留 token，但客户端须更新 URL。

桌面专属**本地 MCP 令牌**列表支持具名 token、到期时间，包括自定义日期、永不过期、编辑和撤销。创建、编辑使用子对话框，已有 token 设置自动保存，创建则仍是显式生成新凭据。恢复默认有效期设为 30 天，不改变名称或秘密。紧凑列表显示摘要和操作，完整随机 token 仅创建时显示。
Token 由 `sk-` 加 43 个不补齐的 Base64url 字符组成，编码操作系统安全随机源的 32 字节，总计 46 字符。只把 SHA-256 哈希、短显示前缀、名称、创建时间、到期时间、上次使用时间及期望 Host、端口保存到当前 WebView 的 `localStorage` 项 `mcp_registry`。原生服务验证修改，渲染器先保存再原生激活，并串行编辑以防丢更新。存储失败不激活修改；保存后激活失败会关闭页面自动化会话，下次打开从保存记录恢复。
列表中的上次使用时间记录最近一次成功的 HTTP 鉴权，包括初始化和工具发现，后续工具调用失败也计入；鉴权失败不更新。没有记录的 Token 显示“暂无使用记录”，无法补回此功能加入前的历史使用情况。原生使用通知直接更新列表并保存时间，无需轮询。Token 列表仅在初始化及创建、编辑、撤销后读取，状态通知不包含它；到期标签由下一个到期时间的一次性定时器更新。使用时间重启后保留，并发编辑及迟到快照会合并最新记录，时间不会回退。元数据写入失败在下一次通知、注册表编辑或显式关闭时重试，不中断 MCP 请求。

权限、待审批请求、审计记录、命令任务状态、控制租约、监听器状态和原生错误通过页面的原生通道推送。页面仅在初始化和显式操作后读取快照，不轮询状态、不发送心跳；会话标识和递增修订号防止迟到快照覆盖新状态。原生维护等待变化通知或权限截止时间，仅在持有输入租约或恢复不可用的紧急停止监听器时保留安全检查。Windows 网络接口通知驱动监听地址更新；无法使用该观察器时，仅对通配地址监听器的可用地址每 30 秒采样。诊断时序采样和显式命令输出读取独立于这些设置通知。
清除此存储会在下次打开重置 MCP 凭据和监听配置。MCP 关闭时仍可列出、创建、编辑、撤销 token。签发 token 授权发现、诊断、转发，以及自动化开启时的本地操作系统调用，无额外本地批准，但不会启动监听器；服务关闭时连接配置采用已保存端点。Token 跨禁用、重启保留，运行时 grant 和待处理调用不保留。过期 token 仍可见，可续期或撤销。
每次 HTTP 请求和最终原生副作用都检查有效性。过期、撤销取消该 token 的 grant 与原生任务。给已过期 token 续期只允许新调用，不能复活旧 grant 或待处理调用，即使两次后台清理 tick 之间也一样。

这些 token 仅认证 MCP 接入客户端，不配对远程设备、不出现在远程设备权限列表，也不授权远程设备。有效 token 连接其他客户端无需额外本地批准。本地操作系统工具仍要求自动化开关，`devices.list` 和五个诊断工具不要求。目标继续执行自己的设备权限。
请求的 Host 必须包含实际接收 socket 的具体 IP 和端口，通配监听也一样；任意 DNS 名称或转发 header 不构成授权。如果存在 Origin，必须匹配该 HTTP origin。不启用浏览器跨源 HTTP 请求。

服务器使用官方 Rust `rmcp` SDK 处理协议协商和传输，包括 SDK 支持的旧协商。工具结果是结构化对象，并有 JSON 文本表示；原生截图的 PNG 只作为 MCP image content 返回，JSON 仅包含图片元数据。MCP 凭据不发送给 peer。HTTP 授权绑定客户端凭据和 grant 生命周期，不绑定单条 TCP 连接，因为现代 MCP HTTP 是无状态的。取消 HTTP 调用只取消该次执行。

原生来源发现和截图等待操作系统时不持有权限锁。返回数据前再次检查 token、grant、请求有效性，取消或撤销会丢弃迟到结果。同时只运行一个原生读取，重叠请求返回 `BUSY`；取消调用者不会立即释放槽位，须等操作系统操作返回。MCP 管理和权限清理不在窗口线程运行，锁与 worker 等待期间仍可处理原生窗口消息。

每个工具都要求显式 `target`，值为 `local` 或直接连接的 Weblink peer ID，通过 `devices.list` 发现。远程调用使用 `automation/1` 能力和有序 WebRTC DataChannel。没有该能力的旧客户端不能调用工具。所有 peer 应用流量还要求[设备配对与内容权限](device-trust.md)。

自动化连接跟随共享 peer 能力通知和消息通道生命周期，不轮询连接设备。双方都允许接收内容后才打开通道，撤回会关闭通道，新的权限声明允许重连。仅打开的自动化通道出现在已连接自动化设备列表。已建立通道可在 close 事件后恢复；打开失败则等待新能力或通道就绪通知，不循环重试。原生输入续期和取消检查独立于 peer 发现、渲染器计时器运行。

## 同意与身份 {#consent-and-identity}

身份和授权保持设备本地。每台目标自行管理信任、权限，不从共享账号或其他设备继承。MCP 接入 token 和远程设备身份是不同凭据。SSO、身份联邦和组织级策略不在当前范围，设备配对与密钥持有证明不要求这些企业能力。

桌面 MCP 入口每次调用都验证 token 及其生命周期。签发 token 已提供客户端授权，本地操作系统调用还受自动化开关限制，发现与诊断仍可使用。向其他客户端转发无需入口额外批准，WebMCP 转发也无需浏览器批准。目标桌面独立执行 peer 权限；MCP 来源标签或控制方 token 不能绕过目标的询问、始终允许、拒绝策略。权限分为三个独立组：

- **读取与诊断**：设备、流状态，截图与无障碍树内容。
- **共享与控制**：屏幕共享、流配置、键鼠输入和语义无障碍操作。
- **终端与命令**：Shell 执行、输出和任务管理。

`packages/automation/src/permission-groups.json` 为 TS、Rust 共同定义这些组。选择组策略会一起更新成员 scope，原生执行仍检查具体工具所需 scope。远程自动化权限位于各设备权限对话框，包括客户端详情与“设置 → 客户端与房间”。每组支持**询问**、**始终允许**、**拒绝**，默认询问。
策略持久保存在本机该设备权限记录中，只应用于当前已配对且验证通过的 peer 通道，信令 ID 或上报的调用者名称不提供授权。失去信任会把所有 scope 重置为拒绝，普通断开和自动密钥修复保留策略。内容接收与屏幕共享开关仍是前置门槛。

设备权限页只包含保存策略控件，不列请求或活动 grant。询问请求使用共享控制请求通知服务：前台显示可操作应用内通知，后台且已启用时显示系统通知。打开系统通知只显示同一应用内批准，不授予访问。两种界面都提供“本次会话允许”或拒绝，不提供时长选择。应用内分裂按钮另有**始终允许**、**始终拒绝**，会保存请求设备当前权限组的策略，并在同一决定中处理当前请求，不改变其他设备或组。
应用内审查显示权限描述、工具参数、上报来源和配置的主机紧急停止快捷键；系统预览省略工具参数并遵守通知预览偏好。Windows 批准横幅保留至请求截止，除非已答复或手动关闭；两种通知都在截止时关闭，不等待刷新待处理请求快照。请求结束会关闭通知，过期、断开或未验证请求不能通过旧操作批准。系统通知答复失败而请求仍待处理时，前台批准仍可显式重试，绝不重放原生回调。本地 MCP token 仍在自动化设置管理，不请求 peer 同意。
会话批准持续到当前连接结束，不改变保存策略，绑定调用者身份、目标、权限组和当前连接生命周期。一次同意只处理同组并发请求，明确拒绝仍排除在 grant 外。修改设备权限立即使受影响 grant 失效。紧急停止把已保存自动化允许改为询问，普通断开保留。原生执行仍检查准确 scope。远程控制允许名单不授予自动化权限；远程设备权限中的“始终允许”是无到期的持久远控策略，与 MCP token、自动化 scope grant 分开。
原生控制快照标识活动 grant 来自远控还是自动化。设备远控策略只作用于远控 grant，自动化保留自己的 scope 检查和共同本地停止。主机标题显示活动自动化输入租约，包括房间外本地 MCP 控制，不显示 token 名称；仅有权限不显示活动控制者。释放、失效租约在下次状态刷新消失，借用已有远控 grant 时只保留一个控制者指示。控制端标题按设备名显示带星光指针的被控设备。逐接收者 `automation.controlActive` 只报告该 peer 当前连接中的活动输入租约；缺少可选字段的客户端不声明传出自动化状态。停止只释放租约，不改变 token 权限或关闭自动化。
同一已验证设备已经控制目标显示器时，`control.acquire` 借用手动 grant 而不替换，返回 `reused: true`。设备 ID、共享连接 generation、采集、来源和几何都必须匹配，自动化权限仍独立检查。本地 MCP token 身份不能借用其他设备 grant。原生快照继续报告手动控制者，媒体与输入通道保持打开。重复获取相同来源幂等；借用租约有自己的 ID、按住输入所有权和可选窗口限制。
释放、取消或窗口聚焦失败只清理借用租约及它按住的输入。人类按住的修饰键、按钮会阻止自动输入，不会成为自动输入的一部分。有效手动输入在处理人类事件前终止借用租约并释放其键、按钮。自动化必须明确重新获取，待处理操作不能恢复旧租约。原生中断、grant 撤销、媒体清理和连接替换均使借用租约失效，过期清理不能释放新租约。
自动化独占 grant 时，主机批准手动控制请求后可替换它，包括已有允许规则的批准；批准前旧 grant 仍活动。同一自动化主体、连接可明确获取另一显示器，只有新目标验证并授权后才替换旧租约，失败切换保留旧控制。借用手动控制从不把人类 grant 移到另一显示器。
每个物理采集来源只有一个应用共享所有者。成功手动控制、MCP `screen.start` 和基于来源的 `control.acquire` 都为房间保留发布。结束控制、切换显示器、权限到期或控制 peer 断开，不关闭已经建立的画面。待处理取消、获取失败和批准过期只释放尚未建立的使用。旧 grant 清理不能停止已有或替代共享。

结束控制、`control.release` 只释放输入。手动控制方没有“关闭屏幕”操作，由共享设备本地关闭。MCP `screen.stop` 显式停止该自动化调用者打开的来源，对所有房间观看者生效，包括音频和控制传输，但其他调用者正控制它时除外。复用画面或交接控制不转移关闭权限。
未声明所有权的 track、属于主机或其他请求者的画面返回 `PERMISSION_DENIED`；其他调用者控制中返回 `CONTROL_BUSY`。重连后，原请求者须先通过 `screen.start` 声明其现有来源，再停止。复用保留采集、音频设置。旧目标在其他所有者仍保留来源时可能返回 `retained=true`。共享设备始终可本地关闭。

基于来源的 `control.acquire` 同时要求 `screen.manage` 和 `input.control`，在采集前与获取输入前各检查一次，最多只需一次审查；任一明确拒绝都会阻止操作。已有 `trackId` 调用保留仅输入权限要求。手动远控只提供“结束控制”，关闭共享屏幕仍由共享设备本地操作；MCP `screen.stop` 执行独立的调用方和来源所有权检查。无状态 MCP 没有会话结束信号，调用者应明确释放输入，不再需要画面时明确停止共享。

策略仍按 client ID 索引，但仅在 peer 证明其配对设备密钥后生效。设备验证失败重置为拒绝。自动配对密钥修复、续期保留保存权限；首次配对与显式重新配对恢复默认设备权限，包括自动化询问，不恢复以前永久授权。

自动化复用已有配对设备认证和有序、受 DTLS 保护的 WebRTC 连接，不增加握手、密钥、比对码或设备身份映射。原生 peer authority 在调用、策略更新和断开清理时使用已验证设备 ID 与共享能力连接 generation。主传输重置更换 generation，旧请求、清理不能影响替代连接。同一连接内重开自动化通道须等待前一通道清理。临时 grant 随通道结束，始终允许只在共享设备验证和接收权限检查后重新应用。

共享协议注册表声明 `automation/1`。消息保留序号验证、有界分帧与接收队列、重复请求拒绝，最多四个并发调用。接收方只接受直接配对 peer，不能路由第二跳。浏览器 Agent 名称与来源标签仅作说明，不授权访问。浏览器 WebMCP 只控制目标并记录有界本地审计，权限决定留在目标原生 authority；本地 MCP 客户端继续使用原有 token 认证。

不完整的分帧组装在 30 秒后过期，即使发送方已经沉默。

原生操作要求绑定已批准请求的一次性 Rust ticket，不注册批准或编辑策略工具，只有主应用打包 UI 能批准请求。Rust authority 在原生副作用前和交付结果前重新检查 grant。应用工具在异步工作前后重查 ticket，原生取消立即通知 UI 中止活动操作。被撤销的 screen-start 中创建的流在发布前销毁。重复请求和迟到清理不能取消同 ID 的新请求。等待同意期间取消会返回、记录 `CANCELLED`，明确拒绝返回 `PERMISSION_DENIED`。
自动化 authority 与远控一样属于原生页面会话。切后台、最小化或隐藏托盘会保留权限和输入租约；原生输入续期独立于渲染器计时器，UI 状态延迟刷新不会结束会话。重新加载页面、销毁主窗口或退出会撤销旧 authority 并取消其工作。Token、批准到期，断开和显式撤销仍结束对应权限。显式绑定目标窗口失去焦点时，仍释放其按住输入并结束该输入租约。

Windows 使用已有**主机紧急停止快捷键**同时停止远控与自动化，即使没有活动控制租约也有效。同一原生监听器遵守配置快捷键，在后台也工作。它立即阻止新调用、撤销 grant、取消待审查请求、排队工作和命令进程树，并释放自动输入。托盘本地撤销使用同一路径，自动化设置没有独立停止按钮。
紧急停止把已保存远程设备自动化允许改为询问，包括离线设备，原拒绝、询问不变。原生 authority 立即取消工作并拒绝重置前的策略写入；渲染器先把重置提交到资料设置再发送新策略。设置和批准通知直接使用这些决定，没有额外 peer-policy 暂停层，重新启用自动化也不会恢复允许。普通断开、重连、结束单个 grant 或关闭应用都保留保存权限，已允许设备重连无需再同意。
紧急停止后，MCP token 调用单独保持暂停，直到关闭再开启 MCP。无法维持原生紧急监听器时报告运行时错误并取消活动工作，不编辑保存权限；监听器恢复前原生操作不可用。窗口失焦、采集结束、输入中断或按住输入超时只结束受影响租约、释放其键和按钮，不重置自动化权限或其他命令任务。重新获取仍需当前采集和有效权限。迟到清理不能压制紧急停止，也不能释放替代租约。本地权限请求等待审查时阻止自动输入。
完整桌面输入可以操作终端和其他应用，因此对已获桌面控制的调用者，单独划分 Shell 工具不构成操作系统沙箱。输入与人类远控共享独占主机 authority 和采集几何验证。撤销不能回滚已执行命令或其他既成副作用。

## 工具与进程限制 {#tools-and-process-limits}

`packages/automation/src/catalog.json` 是工具名、schema 和权限要求的唯一来源，TS 适配器与 Rust 程序共同消费。应用处理器调用服务，不通过自动点击 UI 实现。运行时契约属于 `packages/platform`，Tauri 导入保留在 `apps/desktop`。

- `devices.list`、`sessions.list`：已连接设备与活动流。
- `screen.sources`、`screen.start`、`screen.stop`、`screen.configure`：原生采集发现、不带音频的共享和活动流配置。
- `screen.settings.get`、`screen.settings.update`：读取、更新保存的桌面视频偏好，包括编码器、编解码器及每编码器 preset。
- `control.acquire`、`control.bindWindow`、`control.release`、`control.screenshot`、`control.pointer`、`control.key`、`control.text`：显示器独占控制与有界截图。截图默认适配 1024×1024，可裁剪窗口、矩形。Acquire 要求活动本地原生显示器轨道；指针使用与截图、UIA 共用的桌面物理像素。键盘采用 PC set-1 scan code，文本排除控制字符。可用性由已有原生平台支持决定。
- `commands.capabilities`：使用 `diagnostics.read`，只读发现目标管道后端、stdin/EOF 支持和可用信号。
- `commands.run`、`commands.start`、`commands.status`、`commands.read`、`commands.send`：由创建时准确调用者和 Shell grant 拥有的 Shell 任务。
- `diagnostics.snapshot`、`diagnostics.history`、`diagnostics.start`、`diagnostics.stop`、`diagnostics.export`：已脱敏统计和报告。
- `accessibility.capabilities`、`accessibility.windows`、`accessibility.snapshot`、`accessibility.wait`、`accessibility.action`：桌面无障碍发现、有界元素树与语义控制。

## 设备能力发现 {#device-capability-discovery}

先以 `target:"local"` 调用 `devices.list`。各条目保留已有身份字段，增加以下发现元数据：

| 字段                   | 含义                                                                              |
| ---------------------- | --------------------------------------------------------------------------------- |
| `runtime`              | `browser`、`desktop`，旧 peer 无元数据时为 `null`。                               |
| `os`、`appVersion`     | 发布的运行时元数据，未知为 `null`。                                               |
| `supportedTools`       | 已实现工具名，不受开关或调用者权限影响，`null` 表示未知。                         |
| `automationEnabled`    | 实际操作系统自动化开关，独立于 MCP 控制器开关。                                   |
| `automationConnection` | 自动化通道状态：`local`、`connected`、`connecting`、`disconnected` 或 `unknown`。 |
| `disabledReason`       | `browser_runtime`、`automation_disabled`、`capabilities_unavailable` 或 `null`。  |
| `permissionsVerified`  | 始终 `false`，发现既不验证 grant，也不请求权限。                                  |

已有 `connection` 描述 WebRTC，`automation` 只表示收到自动化能力声明，均不能证明支持桌面控制或 Shell。浏览器 peer 只声明诊断；关闭自动化的桌面仍保留已实现工具列表，同时报告开关关闭。实际调用仍经过目标当前权限与运行时检查。

这些字段是 `automation/1` 的可选扩展，兼容旧 peer。缺失描述符保持未知，不能从通道已打开推断。选定兼容目标后，通过 `accessibility.capabilities`、`commands.capabilities` 获取工具专用的详细限制。

## 结果与恢复 {#results-and-recovery}

每个工具都发布结构化成功、错误输出 schema。成功保持 `{ok:true,data:{...}}`，失败保留 `error.code` 与 `error.message`。额外结果字段向前兼容。旧 peer 可能省略恢复字段，适配器返回给客户端前补充错误信息。

MCP 截图只在 image content block 中包含一次 PNG。JSON 文本和 `structuredContent` 只含来源、物理边界、实际图片尺寸、几何 revision 及图片到桌面映射。内部 peer 传输与浏览器 WebMCP 保持已有图片载荷表示。

错误提供以下恢复信息：

- `outcome: "not_applied"` 表示只读调用，或已知发生在执行前的失败。`"unknown"` 表示改变状态的操作可能已经生效，取消、撤销、断开和截止时间都不能回滚操作系统副作用。`"applied"` 保留给明确确认的副作用。
- `retryable` 只在暂时失败且确定没有应用变化时为 true。明确取消绝不自动重试；重试前先恢复所需连接或权限。
- `nextAction` 建议 `observe`、`reconnect`、`request_permission`、`inspect_capabilities`、`fix_arguments` 等操作，只是指导，不是授权，也不承诺重试成功。
- `retryAfterMs` 若存在，表示可重试失败的建议等待时长。

点击、切换、文本输入或 Shell 启动结果不确定时，先观察目标再决定是否重复。操作已确认但后续观察失败，必须保留已应用结果，不能把操作呈现为未执行。Peer 请求截止返回 `TIMEOUT`，显式 abort 返回 `CANCELLED`。现有逐连接去重不是跨新调用、重连的持久幂等账本。

## 视频偏好 {#video-preferences}

`screen.settings.get` 返回保存的视频偏好、已发现编码器及其编解码器、preset，以及可用显示器、窗口采集后端，使用 `screen.read`；`screen.settings.update` 使用 `screen.configure`。两者要求已开启自动化的桌面目标，复用本地 token 或远程设备权限。仅暴露视频偏好，不暴露凭据、网络配置、音频同意或自动化权限。

传入非空 `patch` 只更新指定字段。未知字段、越界值、不支持的编码器、编解码器、preset、后端选择，在任何偏好写入前拒绝。编码器和编解码器要么都为 `auto`，要么必须是 getter 返回的配对。Preset 属于更新后的编码器；切换编码器时恢复它记忆的 preset，除非 patch 同时指定。`maxBitrate` 单位为 bit/s。

```json
{
  "name": "screen.settings.update",
  "arguments": {
    "target": "local",
    "patch": {
      "encoder": "software",
      "codec": "video/h264",
      "preset": "latency"
    }
  }
}
```

更新使用与设置页相同的持久偏好 store，响应包含 `previous`、`settings`，并在 `application` 下将变化字段分组：

- `liveUpdateRequested`：分辨率、帧率、码率和降级偏好走应用异步实时更新路径，不确认活动流已经接受，之后应查看诊断。
- `nextShare`：编码器、编解码器、preset、采集后端、读回缓冲和颜色偏好在下次共享生效；工具不重启采集。

Getter 报告保存偏好，不是已协商或实际运行值。自动编码器选择可回退到 balanced preset；VP8 无论其他颜色偏好如何，都使用 BT.601 limited range，显式 VP8 颜色 patch 必须符合限制。`screen.configure` 仍可直接、临时修改单条活动轨道，不保存偏好。

## 坐标 {#coordinates}

`desktopPhysicalPixels` 是统一自动化坐标空间，原点为 Windows 物理桌面原点，左侧、上方显示器可有负坐标。边界已处理方向，不能再乘操作系统 DPI 缩放或重复应用显示器旋转。

可用时，`screen.sources` 包含显示布局及 `geometryRevision`。`control.acquire` 返回原生显示器 ID `sourceId`、`bounds`、`virtualBounds`、`geometryRevision`。发布、轨道 ID 不同于这个原生 source ID。`accessibility.windows`、`accessibility.snapshot` 也使用同一坐标空间标记节点边界。

`control.screenshot` 返回 PNG，以及 `imageWidth`、`imageHeight`、物理 `bounds`、`geometryRevision` 和 `imageToDesktop`。从图片左上边缘测量的图片坐标按以下方式转换：

```text
desktopX = imageX * imageToDesktop.scaleX + imageToDesktop.offsetX
desktopY = imageY * imageToDesktop.scaleY + imageToDesktop.offsetY
```

从 `screen.sources` 选择显示器**或窗口**的 `sourceId`；窗口来源使用原生窗口采集，此 ID 与无障碍 `elementId` 不同。截图默认保留宽高比，缩到 **1024 × 1024** 内，不放大小来源。可选 `maxWidth`、`maxHeight` 各接受 1–2048 像素，独立默认为 1024。例如 1920 × 1080 显示器默认返回 1024 × 576，两上限都设 2048 则保留原分辨率。来源选择器预览仍为 640 × 360。

可选 `rect: {left, top, width, height}` 在**缩放前，以绝对桌面物理像素**裁剪所选显示器或窗口。所有字段为整数，宽高为正，矩形必须完全位于所选来源内，否则返回 `RECT_OUT_OF_BOUNDS`。支持负桌面原点，不隐式裁切、补边，也没有窗口相对模式。小区域可保留原生小字细节，而非放大缩略图。例如观察主显示器左侧屏幕上的 600 × 400 区域：

```json
{
  "name": "control.screenshot",
  "arguments": {
    "target": "local",
    "sourceId": "<monitor or window sourceId from screen.sources>",
    "rect": {
      "left": -1800,
      "top": 100,
      "width": 600,
      "height": 400
    }
  }
}
```

返回 `bounds` 描述裁剪后的桌面矩形，`imageToDesktop` 包含偏移和缩放。指针始终使用 `desktopPhysicalPixels`：按变换映射图片点，并使用 `control.acquire` 返回的显示器 `sourceId`、`geometryRevision`，即使截图来自窗口也是如此。PNG 使用均衡的无损 DEFLATE 和自适应行过滤。默认尺寸让不可压缩 RGB 图片也保持在 4 MiB 内，小字细节优先使用窗口、矩形裁剪。显式更大尺寸在本地、peer 传输上仍共用 4 MiB 预算。`RESULT_TOO_LARGE` 要求减小区域或输出尺寸，服务不静默降低请求分辨率，也不改成有损格式。

将映射后的截图点或 UIA 节点物理中心传给 `control.pointer`，使用 `coordinateSpace: "desktopPhysicalPixels"` 和 `control.acquire` 返回的 `sourceId`、`geometryRevision`。点必须位于该显示器内；操作另一显示器前先释放并获取其活动流。物理矩形包含左、上边界，不含右、下边界；小数位置舍入到最近像素中心。

每次指针调用都必须包含 `coordinateSpace: "desktopPhysicalPixels"`、`sourceId`、`geometryRevision`。过期 revision 和不匹配来源被拒绝，显示器外坐标不重定向到相邻显示器。布局变化会使原生控制租约失效，须刷新并重新获取。

窗口截图把 WGC 帧映射到 DWM 物理可见窗口边界，采集前后检查原始帧范围和边界。帧、边界不匹配返回 `CAPTURE_BOUNDS_MISMATCH`，几何变化返回 `GEOMETRY_CHANGED`，不猜测映射。窗口截图不授权窗口控制，指针仍需持有包含目标点的显示器租约。截图或 UIA 观察不是对其他应用 UI 的锁，窗口、元素移动后应重新观察。

## 指针操作 {#pointer-actions}

`control.pointer` 要求 `action`、`target`、`coordinateSpace`、`sourceId`、`geometryRevision`、`x`、`y`。所有点都为已获取显示器内的桌面物理像素，每种 action 只接受自己的参数：

| Action        | 行为与额外参数                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `move`        | 直接移动到 `x/y`；带 `path` 时从 `x/y` 开始，在 `durationMs` 内沿途经点移动。                                           |
| `down` / `up` | 在 `x/y` 按下、释放 `button`；成功调用之间保留按住状态。                                                                |
| `click`       | 按下再释放，`clickCount` 为 1 或 2，默认 1；`holdMs` 为 1–2,000，默认 30；点击间隔 `intervalMs` 为 40–1,000，默认 100。 |
| `drag`        | 在 `x/y` 按下，沿必填 `path` 移动，在最后途经点释放。                                                                   |
| `scroll`      | 在 `x/y` 滚动，`scrollX`、`scrollY` 均必填，各为 −1,200…1,200；不用的轴设 0，120 单位为一格。                           |

`button` 默认为 `left`，也支持 `right`、`middle`、`back` 和 `forward`。`path` 包含起点 `x/y` 之后的 1–128 个 `{x,y}` 路径点。`durationMs` 仅用于路径，默认 500 ms，允许 16–10,000 ms。各段平均分配时间，插值采样间隔不超过 16 ms。时序尽力而为；宿主停顿超过 500 ms 时会中止手势，避免集中补发过期输入。按下按钮前会校验整条路径，包括中间点和终点。

例如，获取显示器控制权并读取当前布局后：

```json
{
  "target": "local",
  "action": "drag",
  "coordinateSpace": "desktopPhysicalPixels",
  "sourceId": "<sourceId from control.acquire>",
  "geometryRevision": "<geometryRevision from control.acquire>",
  "x": 200,
  "y": 300,
  "path": [
    { "x": 400, "y": 300 },
    { "x": 500, "y": 450 }
  ],
  "durationMs": 800,
  "button": "left"
}
```

增量拖动使用 `down`、一次或多次 `move`，最后调用 `up`。重复按下已按住的按钮或释放未按住的按钮会被拒绝。`click` 和 `drag` 要求所有鼠标按钮先释放。结果包含 `heldButtons`、`heldKeys`、`holdExpiresInMs`（没有按住输入时为 null）和实际应用的采样数。键盘和鼠标共用从第一次按下起计时的 30 秒安全期限；移动或按下其他键、按钮不会延长期限。生命周期看门狗每秒检查空闲的按住状态。权限审批也会中断按住输入。无状态 HTTP 客户端不提供持续连接断开的信号，因此没有后续 `up` 的遗留 `down` 调用由该期限兜底释放。

指针手势、键盘和文本输入、UIA 操作及控制权获取共用一个 FIFO 队列。即使调用方丢弃等待中的 future，手势也会一直占据队列直到原生工作线程实际停止。排队调用在执行前重新检查权限和确切的原生控制租约。取消排队任务不会中断当前手势。`control.release` 绕过队列，立即停止控制。

执行期间会在采样之间及等待时检查取消状态和权限；等待不持有应用权限互斥锁。输入开始后，取消、注入失败、权限丢失或几何信息过期都会释放对应的确切控制租约，包括按住的按钮。采集结束、远端断开、授权过期、关机和紧急释放沿用既有原生清理机制。迟到的清理不会释放新所有者或重新获取的租约。手势中断或按住超时后，必须重新获取控制权才能继续输入。

## 直接桌面输入（默认） {#direct-desktop-input-default}

使用 `screen.sources` 返回的显示器 `sourceId` 调用 `control.acquire`，可同时开始或复用共享并获取控制权。也可以传入 `sessions.list` 或 `screen.start` 返回的活动原生显示器 `trackId`。`sourceId` 和 `trackId` 必须且只能提供一个。之后即可直接调用 `control.pointer`、`control.key` 和 `control.text`，无需先调用 `accessibility.windows`、带 `focus` 的 `accessibility.action` 或 `control.bindWindow`。

获取结果包含可用于 `screen.configure` 的 `trackId`；通过 `sourceId` 获取时还包含 `shareReused`，用于区分复用的屏幕发布与新启动的发布。它不同于表示借用设备手动控制授权的 `reused`。`trackId` 形式不会新增屏幕使用者，也不返回 `shareReused`。旧目标可能不提供这些新增结果字段，仍可通过 `sessions.list` 查找活动轨道。完成后调用 `control.release`，释放输入控制但保留画面。`screen.stop` 会为整个房间关闭由本调用方打开的画面，但其他调用方正在控制它时除外。

各类 ID 的含义不同：`screen.sources` 返回的采集 ID 用于 `control.acquire.sourceId`、`screen.start` 和 `control.screenshot`。在 `sessions.list` 中，`captureSourceId` 是同一个采集 ID，`id` 是 `trackId`，而 `sourceId` 是内部发布 ID，并非采集 ID。`screen.start` 适用于仅共享而不控制的场景；通过 `sourceId` 获取控制权无需先调用它。

键盘和文本发送到当前前台应用中获得焦点的控件。指针操作使用物理桌面坐标，以及已获取的 `sourceId` 和 `geometryRevision`；点击控件的效果与实体鼠标相同。Weblink 自身可以留在后台。在应用窗口之间切换不会结束未绑定窗口的桌面租约。该接口不会将按键定向发送到某个后台窗口，接收方由前台应用决定。

后续输入应继续使用该租约。如果租约已有可选的窗口绑定，需要先 `control.release` 再 `control.acquire` 才能恢复桌面输入；仅重复调用 `control.acquire` 会保留现有绑定。

## 可选的窗口范围限制 {#optional-window-confinement}

只有在输入必须限制在单个窗口内时，才需要在 `control.acquire` 后调用 `accessibility.windows`，根据返回的名称和进程信息选择目标顶层窗口。将该窗口的 `elementId` 作为 `windowId` 传给 `control.bindWindow`：

```json
{
  "name": "control.bindWindow",
  "arguments": {
    "target": "local",
    "windowId": "<elementId from accessibility.windows>"
  }
}
```

该操作要求 `input.control`、当前独占原生租约，以及同一调用方拥有的有效窗口引用。子元素、任意 HWND、过期引用及其他调用方的引用都会被拒绝。所有按住的键和按钮必须先释放。绑定会激活所选可见且未最小化的窗口一次，并确认它拥有前台和焦点。激活失败时不会继续发送键盘或指针输入。Windows 仍执行通常的[前台激活限制](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setforegroundwindow)。

结果在通常的成功封装中返回 `{bound:true, windowId, focusPolicy:"stopOnBlur"}`。后续 `control.key`、`control.text` 和 `control.pointer` 自动继承绑定，无需额外参数。绑定变更前已进入队列的输入会以 `WINDOW_BINDING_CHANGED` 失败。每个租约只能绑定一次；更改或移除目标需要释放控制权后重新获取。原生绑定的有效期不受发现引用 TTL 限制，但仍取决于控制租约及原生窗口的身份和生命周期。

原生输入线程会在注入前检查窗口有效性和键盘焦点，包括 Unicode 分批提交之间。指针坐标仍为物理桌面像素，必须同时位于已获取的显示器和可见绑定窗口内；被其他顶层窗口覆盖的点会被拒绝。私有窗口生命周期标记防止回收后复用的原生句柄悄然成为输入目标；原生守卫销毁时移除该标记。空闲的绑定输入约每 50 ms 检查一次。窗口销毁、最小化或失焦会中断输入并释放按住的键和按钮；焦点恢复后不会自动继续。中断后需要重新获取并绑定。

操作可能已经生效，随后最终租约检查才失败。例如，点击绑定计算器的关闭按钮或发送 Alt+F4 可以先关闭窗口，再因剩余输入序列失去目标而返回 `WINDOW_FOCUS_LOST`。绑定输入与无障碍操作在租约清理过程中保留原窗口引用，以一致报告此类中断。这不代表关闭成功，也不会回滚已提交输入。重试前应查询 `accessibility.windows` 或重新调用 `control.screenshot`，确认实际结果。目标窗口已关闭时，关闭任务即已完成；只有还需要继续输入时才获取新租约。没有活动租约的调用仍返回 `CONTROL_REQUIRED`；权限撤销、取消和紧急停止沿用各自的错误。

这是前台输入范围限制，不是后台消息或输入注入 API。对话框或弹出窗口若成为独立的前台窗口，需要重新绑定。UIA 语义操作继续使用其明确的元素目标，绑定不会重定向它们。前台检查与 `SendInput` 之间不存在操作系统级原子事务；实现只是在原生提交之前立即检查，不保证锁定用户的前台窗口。

## 键盘操作 {#keyboard-actions}

`control.key` 使用具名物理键位，例如 `Enter`、`KeyC`、`ControlLeft`、`ControlRight`、`ShiftLeft`、`AltRight`、`MetaLeft`、`ArrowDown` 和 `NumpadEnter`。名称遵循 `KeyboardEvent.code`，不表示当前键盘布局生成的字符。共享目录枚举了支持的键名；不支持 Pause、PrintScreen、媒体键及 F13–F24。字符输入应使用 `control.text`。开发 API 已不再接受原始 `scanCode` / `extended` 参数。

| 操作    | 必填参数         | 行为                                              |
| ------- | ---------------- | ------------------------------------------------- |
| `press` | `target`, `key`  | 按下并释放一个键，可重复执行。                    |
| `down`  | `target`, `key`  | 成功调用后持续按住该键。                          |
| `up`    | `target`, `key`  | 释放当前控制租约按住的键。                        |
| `chord` | `target`, `keys` | 按给定顺序按下 2–8 个不同的键，再按相反顺序释放。 |

`press` 和 `chord` 接受 `holdMs`（1–2,000，默认 30）、`repeat`（1–100，默认 1）和 `intervalMs`（0–1,000，默认 100）。间隔从上一次释放后开始，按住时长从最后一次按下提交后开始。请求的按住和间隔总时长不得超过 10 秒。执行尽力而为，包含提交时间在内最多 15 秒；单次原生提交或调度停顿超过 500 ms 会中止序列。

例如，用 Ctrl+Shift+S 保存：

```json
{
  "target": "local",
  "action": "chord",
  "keys": ["ControlLeft", "ShiftLeft", "KeyS"],
  "holdMs": 50
}
```

使用 Shift+拖动选择时，先调用 `control.key`，传入 `action: "down"` 和 `key: "ShiftLeft"`，执行指针 `drag`，最后通过 `up` 释放 Shift。指针手势保留已按住的键。按键和组合键操作保留其他按住的键及鼠标按钮；如果包含已经按住的键，会在发送输入前拒绝。重复 `down` 或没有对应按下的 `up` 同样被拒绝。所有键盘操作返回与指针操作一致的按住状态字段。

`control.text` 接受 `target`、`text`（1–4,096 个 Unicode 字符）和可选的 `intervalMs`（0–1,000，默认 0）。间隔为零时，每批最多发送 32 个 Unicode 字符，不拆分 UTF-16 代理对。正间隔时逐字符发送，请求的总间隔最多为 10 秒。接口拒绝换行和 Tab 等控制字符；请在文本调用之间显式发送 `Enter` 或 `Tab` 按键操作。文本输入也要求先释放所有按住的键和按钮。它向当前获得焦点的应用发送已提交文本，不自动操作输入法组合过程，也不改变焦点。在 Windows 上，其他进程中受支持的原生 Unicode Edit/RichEdit 控件会在光标或当前选区处接收有界文本替换，保留撤销能力，并避免记事本中快速键盘包导致的文本损坏。默认批次在提交间短暂让出执行，使编辑器能处理窗口消息。其他控件继续使用 Unicode 键盘注入。这不会使用剪贴板或更改输入法。只读或禁用的编辑器不使用直接插入路径。每次提交前检查焦点和窗口范围。提交失败或超时会结束输入租约，不重试文本，因为文本可能已经插入。

按键事件、字符批次和定时等待都会重新检查取消状态、权限、确切的原生租约及共享按住期限。只有有界的原生提交持有权限互斥锁，等待和间隔不持有。执行开始后取消会释放确切租约，包括键和按钮。已输入文本无法回滚，因此文本调用失败后不能盲目重试。预检错误不会发送输入，并保留此前按住的键和按钮。键盘与文本共用指针操作的 FIFO、清理和遗留按住看门狗，包括防止旧清理影响新租约的保护。

## 桌面无障碍接口 {#desktop-accessibility}

Windows 使用 UI Automation。macOS 和 Linux 当前报告 `supported: false`，其他无障碍操作返回 `UNSUPPORTED`。浏览器本地 UIA 调用返回 `UNSUPPORTED`；WebMCP 可以通过现有已授权的对端路由操作连接的 Windows 桌面。

`crates/desktop-accessibility` 中可移植的 Rust `Backend` trait 负责操作系统发现、检查、操作和实现能力。同一个后端描述同时提供 `runtime_capabilities.accessibility` 和 `accessibility.capabilities`；设备发现读取其 actions、`supportsWait` 和 `supportsWindowBinding`，而不是根据系统名称推断。缺失后端元数据不代表支持。`supportsObservation` 决定是否支持可选的操作后读取。`packages/platform/src/accessibility.ts` 定义对应的 TS 契约。未来的 macOS AX 或 Linux AT-SPI 适配器只需实现该后端，并在 `platform.rs` 中选择事件运行时，无需更改工具名、授权流程或传输。共享工作线程继续负责有界队列、取消和引用归属。`EventRuntime` 处理原生事件循环策略；入队、清理和断开都会通知所选运行时。Windows 使用阻塞式 MTA 队列，因为 UIA 在 COM 线程上投递回调。原生对象及订阅均在所属后端线程创建和销毁。角色与操作不依赖平台，节点只声明自身可用的操作。原生指针、HWND 和 COM 接口不会离开后端。

### 读取状态与内容 {#reading-state-and-content}

使用 `accessibility.windows` 获取绑定到调用方的 `elementId` 引用，再用 `accessibility.snapshot` 读取选定子树。结果是扁平的 `nodes` 数组，包含 `parentId`、`depth`、角色、名称、automation ID、进程 ID、物理桌面边界和支持的操作。提供程序实现相应能力时，节点还包含 `toggleState`、`selected`、`expandCollapseState` 和 `readOnly`。可选状态缺失表示不可用，不等于 false。

Value/Text 模式内容需要显式启用。在快照或后续观察中设置 `includeValues:true`，才能获得 `value` 和/或 `text`。`maxTextLength` 默认为 1,024 个 Unicode 字符，允许 1–4,096；`valueTruncated` 和 `textTruncated` 表示有内容被省略。名称最多 512 个字符，缩短时返回 `nameTruncated:true`。默认快照不会查询 Value/Text 内容，适用的语义状态可独立获取。

读取需要读取权限组中独立的 `accessibility.read` 范围。名称和值可能包含应用中的私人文本，因此不会写入诊断报告或审计载荷。密码元素的名称和标识符为空，不查询内容、不遍历子节点，也不允许操作受保护元素。为保护授权界面，Weblink 自身窗口及其托管的 WebView 控件被排除。

```json
{
  "name": "accessibility.snapshot",
  "arguments": {
    "target": "<device ID>",
    "elementId": "<window reference>",
    "includeValues": true,
    "maxTextLength": 1024,
    "maxDepth": 4,
    "maxNodes": 128
  }
}
```

### 操作与后续观察 {#actions-and-follow-up-observations}

`accessibility.action` 支持 `focus`、`invoke`、`setValue`、`toggle`、`select`、`expand`、`collapse` 和 `scrollIntoView`。`setValue` 必须提供 `value`（空字符串用于清空字段），其他操作拒绝 value。不支持的模式返回 `UNSUPPORTED_ACTION`，不会静默降级为键盘或坐标输入。操作要求 `input.control` 权限、**活动原生显示器流上的有效 `control.acquire` 租约**，以及元素引用最初的读取授权。它与现有远程输入共用独占控制和紧急释放机制。显示器是控制租约的锚点，语义操作可以指向桌面上其他窗口。待处理的本地权限审批会阻止包括 UIA 在内的所有自动输入。

可选的 `observeAfter` 在操作应用后请求新的子树。其 `elementId` 默认为被操作元素，并在旧引用失效前解析，绝不会根据名称选择替代元素。观察默认读取两层、64 个节点，硬限制与快照相同：八层、256 个节点；内容读取也使用相同的显式启用选项。

```json
{
  "name": "accessibility.action",
  "arguments": {
    "target": "<device ID>",
    "elementId": "<field reference>",
    "action": "setValue",
    "value": "ready",
    "observeAfter": {
      "elementId": "<window reference>",
      "includeValues": true,
      "maxDepth": 2,
      "maxNodes": 64
    }
  }
}
```

观察成功返回 `applied:true`、`refreshRequired:false` 和 `observation`，其中的新引用可用于下一次调用。操作完成但可选观察失败时，结果保留 `applied:true`，设置 `refreshRequired:true`，并包含 `observationError:{code,message}`。不能因为观察失败而重放操作。未提供 `observeAfter` 时，仍返回原有的 `applied:true,refreshRequired:true`。

授权撤销后，最终权限检查仍会丢弃 UI 数据。如果该边界已经知道操作已应用，失败会保留 `error.outcome:"applied"`，但不返回已撤权的观察数据。确认前丢失响应的操作仍可能具有未知结果。

### 等待条件 {#waiting-for-a-condition}

`accessibility.wait` 使用 Windows UIA 事件等待同一引用元素满足所有指定条件。它先读取一次当前状态，之后只在收到事件通知时重新读取；没有周期轮询、轮询降级或截止时的最终扫描。它要求 `accessibility.read`，不要求输入租约。条件可以包含 `enabled`、`focused`、`offscreen`、`selected`、`toggleState`、`expandCollapseState`、精确 `name`、精确 `value` 和 `textContains`。条件对象不能为空。精确比较不会匹配被截断的名称或值；文本搜索只检查返回内容的前 4,096 个字符。仅在条件需要时查询 Value/Text 模式。

```json
{
  "name": "accessibility.wait",
  "arguments": {
    "target": "<device ID>",
    "elementId": "<checkbox reference>",
    "condition": { "enabled": true, "toggleState": "on" },
    "timeoutMs": 10000
  }
}
```

唯一的时间选项是整体 `timeoutMs`，默认 5,000 ms，接受 1–30,000 ms 的整数。匹配时返回 `{matched:true,timedOut:false,elapsedMs,node}`，包含新建的调用方专属引用。条件期限到达时返回 `{matched:false,timedOut:true,elapsedMs,node:null}`。元素过期、授权撤销或提供程序失败仍属于工具错误，而不是条件超时。失败的条件检查不会延长原引用寿命，也不会分配用完即弃的引用。

UIA 提供程序可能漏发事件。首次读取后没有收到相关通知时，即使状态已改变，等待也会正常超时。超时仅表示未观察到匹配，不证明当前条件为假，也不证明之前操作失败。调用方可显式调用 `accessibility.snapshot` 调查超时；等待实现不会自动获取该快照，超时也不能作为重放操作的理由。

### 引用与执行边界 {#references-and-execution-bounds}

引用在 60 秒后、原读取授权结束时，或操作进入分发阶段后失效。操作会使该调用方所有旧引用失效，即使提供程序报错或超时也是如此；请刷新 UI，或使用成功观察返回的新引用。引用不能被其他调用方或重连后的会话使用。发生变化或重新挂载的 UI 元素绝不会根据可能存在歧义的标签重新选择。

快照默认最多 128 个节点、四层，硬限制为 256 个节点、八层。`truncated` 表示子节点被省略；可以展开返回的子节点引用继续检查。窗口列表最多 128 项。原生缓存最多保存 2,048 个引用，因此其他发现操作可能使引用提前被淘汰。

UIA 在单独的专用 COM MTA 线程运行，最多排队四个请求，每个工作请求的期限为八秒，提供程序连接和事务超时为 500 ms。事件等待在该线程外进行，UIA 订阅和读取在其内部执行。每次检查还受条件剩余期限约束。操作与后续观察是独立工作请求，因此观察阻塞不会抹去操作确认。

遍历步骤之间、事件触发读取前、原生操作前和返回 UI 数据前都会重新检查权限。原生提供程序调用不持有应用权限锁。取消或撤权会阻止排队任务；已分发到其他进程的副作用无法撤销或强制中断。无响应的提供程序可能持续占用唯一工作线程直至调用返回，但 UI 和权限控制仍保持响应。不尝试提权或绕过 UIAccess，因此无法访问或已提权的窗口可能不可用。

Windows 实现遵循 Microsoft 关于 [UIA 客户端线程](https://learn.microsoft.com/en-us/windows/win32/winauto/uiauto-threading)和[提供程序事务超时](https://learn.microsoft.com/en-us/windows/win32/api/uiautomationclient/nf-uiautomationclient-iuiautomation2-get_transactiontimeout)的指导。

## Shell 执行 {#shell-execution}

终端权限与桌面读取、控制权限分开管理。目前没有实现交互式 PTY 传输；未来的终端工具可以共用该权限组，以及相同的调用方/目标归属和撤权规则。

`commands.run` 等待完成并返回 `jobId`、`status`、`exitCode`、`chunks`、`startCursor` 和 `nextCursor`。输出为最新的 16 KiB，确保大量日志之后的最终结果和错误仍可见。更早保留的输出可通过 `commands.read` 和明确游标读取。`waitMs` 默认 10 秒，范围为 1–60,000 ms。等待先结束时，`background: true` 表示任务仍在运行；使用其 `jobId` 调用 `commands.status`、`commands.read` 和 `commands.send`。`commands.start` 总是立即只返回 `jobId`。两者使用同一任务管理器、并发限制、调用方归属和终端权限。

### 读取后台任务 {#reading-a-background-job}

启动任务（以下示例使用 Windows PowerShell）：

```json
{
  "name": "commands.start",
  "arguments": {
    "target": "local",
    "script": "Write-Output 'started'; Start-Sleep -Seconds 2; Write-Output 'finished'",
    "timeoutMs": 60000
  }
}
```

成功载荷为 `{ok:true,data:{jobId:"..."}}`。标准 MCP 在 `structuredContent` 和 JSON 文本内容中提供该封装。无需先查询任务输出大小，即可读取最新输出：

```json
{
  "name": "commands.read",
  "arguments": {
    "target": "local",
    "jobId": "<returned jobId>"
  }
}
```

不提供选择器时返回最新的 16 KiB。也可选择提供以下**一个**参数：

- `tailBytes: 8192`：最新的 8 KiB，接受 1–16,384 字节。
- `tailLines: 50`：最新的 50 行，接受 1–1,000 行，仍受 16 KiB 限制。`tailLimited:true` 表示所选行超过字节上限，开头已被省略。行以 stdout 和 stderr 合并到达顺序中的 LF 划分；保留 CRLF，末尾 LF 不额外增加空行。
- `cursor: <nextCursor>`：从绝对字节偏移向前读取，每页最多 16 KiB。`cursor:0` 从最早仍保留的输出开始。

这些模式互斥。重复尾部请求会得到另一份可能与上次重叠的快照。若要跟踪新输出，后续读取应始终使用上一响应的 `nextCursor`。

成功封装的 `data` 包含 `chunks`、`startCursor`、`nextCursor`、`hasMore`、`bytes`、`retainedBytes`、`earliestCursor`、`truncated`、`cursorExpired`、`tailLimited`、`outputIncomplete`、`status` 和 `exitCode`。每个块标记为 `stdout` 或 `stderr`，同时包含显示用的 `data` 和精确字节 `dataBase64`。游标是跨两个流累计的字节偏移，旧输出被淘汰时也不会重置。即使没有新输出，也应原样传回 `nextCursor`。不要按字符计数，也不要分别维护各流的游标。

缓冲区始终保留**最新**输出，最多 4 MiB 和 8,192 个连续流片段；空间不足时淘汰最旧字节或片段。`bytes` 统计所有已观察字节，`retainedBytes` 为当前缓冲区大小，`earliestCursor` 为首个可用偏移。`truncated:true` 表示旧输出已被淘汰；主动选择尾部本身不会设置该标志。

显式游标落后于 `earliestCursor` 时，从最早可用位置继续读取，并返回 `cursorExpired:true`；`startCursor` 表示本页实际起点。丢失字节数为 `startCursor - requestedCursor`。超过 `bytes` 的游标无效。已经消费被淘汰前缀的及时读取者，可以在 `truncated:true` 时仍得到 `cursorExpired:false`。

轮询规则如下：

```text
page = commands.read(target, jobId).data  // latest output first
loop:
    if page.cursorExpired: report gap and reset streaming decoders
    consume page.chunks
    cursor = page.nextCursor
    if not page.hasMore:
        if page.status != "running": stop
        wait approximately 500 ms
    page = commands.read(target, jobId, cursor).data
```

`hasMore:false` 仅表示当前已读完，不是输出结束通知。使用显式游标时，即使任务完成也可能还有未读页面。只有同时满足 `status != "running"` 和 `hasMore == false` 才能结束。`commands.status` 可用于只轮询状态，不返回输出。发送终止信号后，仍应继续读取，排空保留输出并观察最终状态。读取采用轮询，不是推送流；进程自身的缓冲可能延迟新字节出现。只有两个输出读取器都停止后才发布终态。`outputIncomplete:true` 表示管道读取失败或达到两秒排空期限，区别于普通缓存淘汰，说明收集结果可能未包含全部进程输出。

### 发送输入与信号 {#sending-input-and-signals}

选择信号前查询 `commands.capabilities({target})`。发现操作在指定设备上执行，也包括远端目标，绝不根据控制端操作系统推断远端支持情况。它要求 `diagnostics.read`，不会启动进程，也不授予 `shell.execute`。常规自动化启用和权限检查仍然适用。结果描述后端能力，不代表解释器已安装，也不保证具体任务收到信号后会退出。

Windows 桌面返回：

```json
{
  "supported": true,
  "transport": "pipe",
  "stdin": true,
  "eof": true,
  "pty": false,
  "supportedSignals": ["SIGTERM", "SIGKILL"],
  "signalSemantics": {
    "SIGTERM": "terminate-process-tree",
    "SIGKILL": "terminate-process-tree"
  }
}
```

Unix 桌面还将 `SIGINT` 列为 `interrupt-process-group`，将 `SIGTERM` 描述为 `terminate-process-group`；`SIGKILL` 仍为 `terminate-process-tree`。浏览器本地 WebMCP 发现返回 `supported:false`、`transport:"none"`、`stdin:false`、`eof:false`、`pty:false`、`supportedSignals:[]` 和 `signalSemantics:{}`。浏览器仍不接受传入的对端自动化。没有该工具的旧目标返回 `UNSUPPORTED`，控制端不会用自身能力替换该响应。所有桌面任务仍使用管道传输，不提供终端仿真。

`commands.send` 取代 `commands.cancel`。旧的取消行为请使用 `signal: "SIGKILL"`。每次发送都要求原调用方、目标和 Shell 授权。已完成或正在取消的任务以 `JOB_NOT_RUNNING` 拒绝发送；进程已停止但仍在收集最终输出时也一样。

标准输入在显式关闭或任务结束前保持打开。通过 `input` 发送字面 UTF-8 文本，不会自动补换行。每次最多接受 16,384 个 Unicode 字符 / 65,536 个 UTF-8 字节。每个任务最多排队八条输入消息。`BUSY` 表示新消息未入队。响应 `{queued:true,bytes:...,eof:...}` 仅确认队列接受，不代表进程已经消费输入。发送按接受顺序串行执行；标准输入管道阻塞不会阻塞其他工具、信号、撤权或紧急停止。

```json
{
  "name": "commands.send",
  "arguments": {
    "target": "local",
    "jobId": "<returned jobId>",
    "input": "hello\n",
    "eof": true
  }
}
```

`eof:true` 会在先前排队输入及本次输入写完后关闭标准输入，也可以单独发送。EOF 被接受后，后续输入以 `STDIN_CLOSED` 拒绝。运行结果、读取和状态包含 `stdinStatus`：`open`、`closing`（EOF 已排队）、`closed` 或 `failed`（管道写入失败）。取消或退出会丢弃尚未写出的输入。PowerShell 仍使用 `-NonInteractive`；请使用标准输入 API 或原生程序，不要使用 `Read-Host` 或控制台 UI 提示。这不会添加 PTY 或终端仿真。JSON 转义控制字符（包括 `\u0003` 和 `\u0004`）会按字面写入，不会隐式发送信号或关闭输入。每条消息的缓冲写入都会刷新，即使没有后续发送，也能报告延迟的管道失败。成功 EOF 会在关闭输入前完成这些写入；写入失败则保留 `stdinStatus:"failed"`。

信号与 `input`、`eof` 互斥：

- `SIGKILL`：在所有平台取消任务并终止进程树；最终状态为 `cancelled`。
- `SIGTERM`：Unix 向进程组发送 TERM；Windows 终止进程树（Windows 没有 POSIX TERM 投递机制）。Unix 处理程序可能继续运行任务，需要强制终止时使用 `SIGKILL`。
- `SIGINT`：Unix 向进程组发送 INT。Windows 返回 `UNSUPPORTED_SIGNAL`，因为这些任务没有可接收 Ctrl+C 的控制台或 PTY。

信号接受后返回 `{queued:true,signal:...}`；应轮询完成状态，不要假定立即退出。信号投递绕过标准输入队列。授权撤销、过期、紧急停止和关机会始终强制清理进程树。

`data` 是有损 UTF-8 显示视图；按字节选择尾部、淘汰和分页边界都可能切断字符或行。需要精确文本时，应解码 `dataBase64`，按程序实际编码为每个流分别使用流式解码器，或先按流拼接字节再解码。`cursorExpired` 表示缺口时重置两个解码器，不要跨丢失输出拼接字节。只有任务结束且请求的全部页面都读完后，才最终刷新解码器。

使用相同目标、调用方/令牌身份和原终端授权。新授权不会授予旧任务的访问权。任务和输出仅保存在内存中，不会跨应用重启保留；达到 32 条记录上限时，已完成记录可能被移除。授权过期、撤销或断开取消可以停止正在运行的任务；`start` 是后台移交，不是独立持久服务。

`waitMs` 限制工具等待时间，`timeoutMs` 独立限制进程寿命。运行结果和读取每页最多包含 16 KiB 保留输出。`hasMore` 表示还有保留字节未读；即使为 false，运行中的任务之后仍可能生成新字节。继续从 `nextCursor` 读取；默认尾部省略了需要检查的旧输出时，可显式传入更早的游标。非零退出仍是已完成任务，并携带退出码；进程超时报告 `timed_out`。运行请求等待期间被取消，会取消其任务。成功移交后台后解除调用级取消关系，但授权撤销、过期和关机仍会取消 run 与 start 所拥有的进程树。等待不持有权限互斥锁，因此权限变更仍可执行。

Windows 优先使用非交互式 `pwsh.exe`，仅在首选可执行文件缺失时回退到 `powershell.exe`。脚本失败不会触发换用解释器重试。每个 Windows 任务将控制台输入/输出和 PowerShell 原生管道编码设为无 BOM 的 UTF-8，并将 cmdlet `Encoding` 参数默认设为 `utf8`（脚本显式参数可覆盖）。Windows PowerShell 向 UTF-8 文件写入时仍可能包含 BOM。明确输出其他编码的程序仍须按对应编码解码原始输出。其他平台使用 `/bin/sh`。命令以应用账户权限运行；它**不是沙箱**，工作目录也不是访问边界，不会提权。只继承基础系统环境变量，不继承应用凭据。任务默认 60 秒，最多十分钟，每个设备最多并行十个任务。每个任务保留输出最多 4 MiB，总共最多 32 条任务记录。达到输出或片段上限后，淘汰最旧输出，继续保留新输出。读取使用绝对字节游标，并包含 base64 字节，支持跨 Unicode 边界精确重建。完成、取消和超时会清理所属进程组或作业。Shell 进程可能产生持久影响；该机制用于有人值守的诊断和自动化，不用于隔离恶意代码。

## 诊断 {#diagnostics}

应用拥有的采样器在活动视频会话期间运行，独立于设置界面。它约每秒采样一次，在内存中保留五分钟，最多 8 MiB。采样区分本地预览、发送和接收，并在播放器挂载时包含播放器状态及合成器统计。后台调度空档和缺失指标会明确保留，不会用不相关的阶段测量推算端到端延迟。

详细采集须显式启用，最多持续五分钟，增加累计计数器和原生管线耗时。报告保留错误码、编解码器实现、运行时版本和关联 ID，同时排除原始 RTC 报告、SDP、IP 地址、路径、凭据及屏幕内容。历史和工具导出按每页最多 30 个样本分页；设置中的导出收集整个保留时间窗口。关闭应用会丢弃历史。审计记录最多保存 1,000 次调用，包含调用方、工具、目标、时间和结果，不包含脚本、命令输出、截图或输入文本。

协议参考：[WebMCP](https://webmachinelearning.github.io/webmcp/)、[Rust MCP SDK](https://github.com/modelcontextprotocol/rust-sdk)、[MCP Streamable HTTP](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http)。
