# Weblink 架构与目录指南

Weblink 是采用 SolidJS 与严格 TypeScript 的 WebRTC 聊天、文件传输应用。UI 有意保持轻量：组件通过稳定接口与应用状态、服务交互，WebRTC、会话和传输细节保留在底层 `domain`。

## 顶层目录 {#top-level-layout}

- `apps/web/`：前端应用、Vite 配置、资源、测试，以及应用构建、浏览器脚本，是 Bun 工作区。
- `apps/desktop/`：Tauri 外壳与桌面平台适配器，以 desktop 模式构建同一前端，使用独立输出和原生权限，应用版本来自 `apps/web/package.json`。
- `apps/docs/`：独立的 VitePress 文档构建与主题，从 `docs/` 的中英文对应目录读取正文。
- `packages/platform/`：两个应用共用的平台能力与适配器契约。Vite 在构建时选择运行时适配器，浏览器 bundle 不导入 Tauri API。
- `crates/desktop-capture/`：独立于 Tauri 的 Rust 采集服务、Windows 采集后端、原生编码、WebRTC 和本地预览。
- `crates/desktop-input/`：独立于 Tauri 的控制授权与 Windows 键鼠 worker，包含原生撤销及自有窗口输入探针。桌面组合层把它绑定到显示器共享和本地同意，浏览器鼠标控制使用原生媒体 DataChannel，无需逐事件 IPC。
- `servers/weblink-ws-server/` 和 `servers/weblink-ws-worker/`：独立 Git 子模块，同时参与 Bun 工作区安装。
- `package.json` 和 `bun.lock`：根工具、共享依赖安装和命令入口。应用版本属于 `apps/web/package.json`。
- `docs/`：共享的架构、协议、开发与部署文档。
- `docker/`：Docker 镜像使用的 Nginx 模板与入口脚本。
- `scripts/`：仓库级辅助工具，应用脚本放在 `apps/web/scripts/`。

有人值守的 Windows 远程控制复用现有媒体路径。键盘、文本转发与远程桌面入口的当前行为见[桌面端开发](desktop.md)，依赖和子模块流程见[工作区开发](workspace.md)。

以下应用源码路径均相对于 `apps/web/`。

## 相关信令仓库 {#related-signaling-repositories}

- [`weblink-ws-worker`](https://github.com/99percentpeople/weblink-ws-worker)：Cloudflare Workers + Durable Objects 实现，推荐的无服务器 WebSocket 部署。
- [`weblink-ws-server`](https://github.com/99percentpeople/weblink-ws-server)：用于自托管和回滚的 Bun 实现。
- 端点配置、协议所有权、部署验证和回滚见[信令服务](../reference/signaling.md)。

## `src/` 目录 {#src-layout}

### UI {#ui}

翻译字典位于 `src/assets/i18n/`。含义相同的操作复用 `common.action.*`，共享反馈复用 `common.notification.*`。功能专用说明和不同操作留在各自命名空间；仅英文单词相同不表示两个 key 可以互换。翻译应使用带占位符的完整消息，不拼接片段。

- `src/app.tsx`：应用外壳，包含 provider、全局 UI 和对话框。
- `src/constants.ts`：UI、应用、领域共用的项目常量，包括存储键、超时和前缀。
- `src/routes/`：基于 Solid Router 的路由页面。
  - `src/routes/home/`：主路由 `/`，包含会议舞台、底部媒体控制，以及具有常驻聊天、成员、房间信息标签页的浮动面板。会话列表位于聊天标签页内，没有单独聊天页。宽屏可展开为会话列表与聊天分栏；紧凑屏幕先显示会话列表，选择条目进入聊天，聊天标题提供返回列表按钮。

    桌面用一个控件切换紧凑、展开面板。窗口过窄、无法同时保留会议画布时，展开面板自动铺满工作区；窗口变宽后重新停靠到画布旁。只隐藏画布，不卸载媒体或改变用户选择的展开状态，Escape 关闭面板。移动面板替换画布，并提供返回会议操作，不采用模态遮罩。展开保留已挂载聊天，切换标签页保留面板宽度。固定标签组锚定右侧，指示器滑动，新内容淡入。宽度使用 CSS transition 和舞台原有 ResizeObserver，不缩放文字，也不为侧栏增加观察器。移动检测与展开停靠共用一个视口 resize 快照，保持面板宽度和画布可见性同步。选会话只更新 `conversation` 查询参数，不换房间，并保留原有媒体预览哈希契约。

    应用媒体控制器独立获取麦克风、摄像头和多个共享屏幕。显示器采集通过浏览器选择器请求可选音频，每条返回音轨归属对应显示器：麦克风静音、设备变化不影响它；停止显示器，包括浏览器停止操作，会移除其音频。仅音频结束仍保留画面，无音频采集也有效，可用音源取决于浏览器和平台。标题开关原地静音、恢复所有当前显示器音频，保留麦克风和视频。新显示器继承静音状态，直到全部显示器停止；没有捕获显示器音轨时禁用开关。

    应用服务拥有采集轨道，流容器变化时保留仍需使用的轨道。离开房间断开 peer，但保留本地采集与预览，重新加入复用活动轨道。网络恢复也重新绑定活动轨道，不重开用户或浏览器已停止的采集。显式标签页接管仍会停止旧页面采集。

    舞台将参与者身份视图，即头像或摄像头及麦克风所有权，与共享屏幕视图区分；固定的是视图，不是参与者。第一个出现的共享屏幕自动成为主视图，后续屏幕不覆盖手动固定。移除来源先完成短暂淡出再释放视图。`stream-state` 将每个已协商视频 transceiver MID 声明为 camera 或 screen。接收轨道的本地 ID 只留在会话运行时，通过 `RTCTrackEvent.transceiver.mid` 关联来源语义，UI 身份不依赖跨 peer 的 `MediaStreamTrack.id`。同一快照把麦克风、共享音频 MID 关联到对应视图，共享音频引用屏幕 video MID。一个音频播放器保留播放与扬声器选择，各块只控制自己的音频组；麦克风组在摄像头、头像切换后继续存在。成员静音控制所有组，全局静音控制播放。

    所有舞台视图使用 16:9 容器，以 contain 显示视频。舞台拥有的一个 ResizeObserver 测量网格分配的 content box，按动画帧合并更新。网格列、居中偏移和块尺寸共用测量，兼顾宽高，并在列边界附近加入迟滞。尺寸 containment 防止块内容反过来改变观察框，来源数量变化复用测量和观察器。焦点、单视图同时适配可用宽高；缩略图栏独立滚动，可折叠而不卸载视频元素。每个来源有一个 keyed Portal 所有者，布局变化时在网格、焦点框和缩略图栏之间移动现有视频视图。

    网格尺寸、来源列表、显式布局和缩略图可见性变化通过 `hooks/layout-transition.ts` 使用 Motion JS，以稳定视图身份匹配布局。Resize 和来源变化共用网格帧队列，首次和隐藏状态测量直接更新，不播放入场。移动框暂时脱离文档流和缩略图栏裁剪，控件行保留空间，之后恢复缩略图滚动；过渡中断先捕获当前帧，再清除动画样式。头像尺寸单独插值并补偿父级缩放；名称浮层抵消框缩放以保持字体、内边距，边距与可用宽度随过渡变化，长名截断于框内。开关侧栏在目标快照前刷新同一网格测量，使面板与舞台一起过渡。过渡保留单一观察器，尊重减少动态效果偏好，销毁时清除样式。`components/ui/motion.tsx` 提供声明式入场、离场的 Solid `Motion.*` 和 `AnimatePresence`，API 与布局作用域见[界面动效](ui-motion.md)。

    共享状态位于标题右侧，媒体错误用临时 toast。可展开控件选择麦克风、摄像头和支持的扬声器输出。选择未启用输入只记录偏好；切换活动输入先取得替代轨道，再释放旧轨道，保留静音与其他采集。枚举设备不自行请求采集权限，输出路由由应用音频控制器管理。
    `hooks/media-device-access.ts` 结合权限查询和已暴露设备身份。缺少访问权限时，标题显示打开设备设置的操作；已阻止、无设备、不支持分别表示。显式授权短暂采集输入、枚举设备后释放所有探测轨道，从不发布。扬声器访问优先使用原生输出选择器，否则在说明后临时申请麦克风授权。权限变化和窗口获得焦点刷新状态，销毁释放监听器及迟到的采集结果。

    `libs/state/create-meeting-media.ts` 在应用范围组合共享控制器与设备发现。工具栏、房间设备对话框共用状态，关闭任一视图保留设备选择和已发布媒体；房间变化取消待处理采集。采集实现在 `application/meeting-media-service.ts`，依赖注入的媒体、流端口。房间设置中的设备选择只保存偏好，不打开、替换流。尚未应用的偏好跨流更新保留，下次工具栏激活时使用，包括取消保留麦克风的静音。工具栏显式设备变化仍可替换活动来源。

    `libs/state/create-meeting-session.ts` 位于路由页面之上，管理来源选择、固定状态，以及独立的缩略图栏和工具栏可见性，Home 与画中画共享。每种布局，包括网格和单来源，都有独立工具栏收起、显示控制；折叠缩略图不改变工具栏。工具栏折叠时隐藏缩略图开关，只保留显示工具栏操作；重新显示恢复开关，不改变缩略图栏状态。
    控制器还拥有 Document Picture-in-Picture 窗口，复用焦点舞台，包含主来源、可折叠缩略图栏和同一媒体控制器驱动的紧凑控件。PiP 保持焦点模式，工具栏没有网格切换。选择缩略图切换主视图。主来源优先取固定来源，否则为第一个活动视频或首位参与者；选择缩略图更新共享固定状态，不重建视频视图。

    PiP 打开时，Home 仅把舞台换为 SVG 提示和返回操作，侧面板与聊天保持挂载，不停止采集。舞台使用自己 document 的动画帧和 ResizeObserver 调度 resize、来源更新，打开方隐藏时 PiP 仍可更新。`hooks/document-picture-in-picture.ts` 管理待处理请求、原生关闭与销毁，不拥有轨道。子 document 接收应用样式、主题更新与自己的 Solid 委托事件处理器，窗口关闭时全部清理。

    新视频来源仅在舞台活动且视频首次进入视口后附加，避免初始布局隐藏时启动静音内联视频。播放恢复跟随元数据、就绪、重复 track unmute、document 前台和视口可见事件。舞台另显式暴露画布、缩略图可见性，因为 CSS 可见性不一定改变 intersection。显示、解码尺寸变化以及原生 PiP、全屏呈现事件会重试暂停的活动视频并刷新内联播放，即使浏览器仍报告正在播放。恢复可取代待处理 play 请求，迟到结果不能改变当前播放状态。
    隐藏已绑定视图会为 PiP 保留来源；恢复不替换健康流，也不停止借用轨道。自动播放被拒绝后，保留已翻译的 toast 操作供用户主动播放，不绕过浏览器策略，也不按 user agent 推断编解码器支持。

    移动布局中，每个可播放视频块在标准或 WebKit 呈现 API 支持时独立提供原生视频 PiP。原视频元素在提示和恢复操作下保持挂载，关闭 PiP 不停止借用轨道。视频 PiP 无自动进入设置，由视频块拥有，来源移除时关闭。确认进入移动视频 PiP 后，通过现有布局过渡将该来源选为主视图；重复进入幂等，退出保留选择，失败、取消不改布局。全屏根据解码尺寸，在 Screen Orientation API 允许时请求横屏或竖屏，跟随视频 resize，退出仅释放自己的锁。不支持或拒绝方向锁定不阻止全屏。

    自动 Document PiP 是可选应用偏好，要求至少一条本地或远端视频轨道活动、启用且未静音；纯音频与占位来源不符合条件，手动入口仍可用。待处理请求结束后重新检查视频条件。内部路由离开在导航手势内请求；浏览器切标签页和窗口遮挡使用 Media Session 的 `enterpictureinpicture` 操作。后台请求要求 document 隐藏或浏览器明确给出 `contentoccluded` 原因，并且没有待处理屏幕选择器。浏览器遮挡通知可能早于 visibility 事件，或 document 仍保持可见；仅失去焦点不会打开 PiP。
    隐藏事件也会在临时用户激活仍有效时请求 PiP。能否后台进入由浏览器资格与站点权限决定：Chrome 即使在 localhost 也要求 HTTPS，会议采集通常要求活动麦克风或摄像头，仅屏幕采集不符合 Chrome 会议条件。最近用户激活可能让首次离开打开 PiP，但不保证之后每次离开都能打开；可听播放也有自己的浏览器条件。
    返回可见且获得焦点的会议页面时，仅关闭后台触发的 PiP，包括待处理请求。Visibility 与 focus 都处理返回并重置原生关闭抑制；仅可见不能证明用户从子窗口返回。这些事件不绕过浏览器激活规则。关闭打开方或把该标签页导航到其他网站后，小窗口无法继续存在。

  - `src/routes/client/[id]/sync.tsx`：peer 文件同步，从会话菜单进入，标题可返回 Home。
  - `legacy-home.tsx` 把 `/home`、`/video`、`/chat` 以及旧会话、私聊链接重定向到 Home，保留邀请和媒体哈希。`/file`、`/setting` 是兼容入口，在 Home 打开对应对话框后移除一次性 `dialog` 参数。
  - 设置页及对话框中的设置式控件使用 `components/settings/setting-layout.tsx` 提供分区、标题和带标签字段，使用 `setting-controls.tsx` 提供开关、选择器、滑块和快捷键录入。值、权限和保存回调保留在功能页面，共享间距、字体和控件宽度放在 `settings.css`。选择器与标签并排，多行字段显式使用 `layout="stacked"`；操作按钮使用 `layout="compact"`，让其列贴合按钮并右对齐。自定义字段通过 `SettingField` 渲染回调获取稳定的 label、description ID。

    分隔线放在后续设置或内容组之前，使用通用兄弟选择器，避免提示和包装层打断；不要给每行底边加边框。含设置的容器作为整体参与，并在内容上方留内边距。自定义内容用 `SettingBlock` 获取共享垂直间距，其 `separated` 选项可显式增加组分隔线。

  - `src/components/settings/`：共享设置对话框中的外观、连接、传输、高级和关于分区。桌面使用分类侧栏，移动使用横向标签。选项保留现有持久键并立即生效。ICE 探测和凭据解析属于注入的应用诊断服务，不属于视图。关于页内联显示共享应用元数据，只复制版本和构建时间。确认重置偏好会替换可选值与每房间、成员映射；清理页面缓存影响 Cache Storage 和 service worker。两者都保留会话历史和 IndexedDB 文件缓存。

- `src/components/`：可复用 UI 构件。
  - `components/app/`：应用范围的操作、对话框、账号下拉和 wake lock。原全局导航侧栏已移除。账号菜单打开本地文件管理、任务、设置，并保留房间共享和二维码操作。对话框控制器位于路由页面之上，打开不离开 Home，也不触发自动 PiP。

    设置、文件管理菜单项在指针进入、键盘聚焦或触摸按下时预热懒加载 chunk。`libs/utils/preload.ts` 与渲染共享 import，成功后预备 Solid 公开 lazy API；后台预热失败可在打开时重试。预加载不挂载对话框内容，也不启动应用操作。路由链接保留 Solid Router 原有组件预加载。
    `room-actions.tsx` 统一加入与编辑。已配置资料可直接加入，首次用户先配置资料，并阻止并发加入。共享房间编辑器立即保存修改，即使关闭时未连接也一样；其连接操作从任一入口验证资料并加入房间。关闭文件、设置对话框不销毁会议媒体或活动聊天。

  - `components/files/file-manager.tsx`：对话框内本地文件管理，保留导入、过滤、预览、下载、转发和删除。紧凑列表在对话框内滚动，仅打开时挂载。`file-browser.tsx`、`file-filters.tsx`、`file-list.tsx`、`file-picker-dialog.tsx` 在管理器与输入区共用搜索、过滤和选择。发送已有内容使用 `FileSource`，即 `File` 或 `{ kind: "library", localFileId }`，保留草稿和选择器打开时捕获的会话。
  - `global.css` 接入 `packages/theme/tokens.css` 的共享明暗蓝灰配色与圆角尺度。设置 `:root --radius` 调整所有非圆形角；Tailwind `rounded-*` 按比例派生，`sm` 用于标签、菜单项，`md` 用于控件，`lg` 用于面板，`xl` 用于对话框、工具栏，默认分别为 8/12/16/20px。组件 CSS 使用 `@reference` 与 `@apply rounded-*`，圆形控件保留 `rounded-full`，避免固定圆角值。会议 CSS 使用这些变量，PiP document 同步主题变化。Home 的组件专用呈现与 JSX 中的 Tailwind 共置，`routes/home/index.css` 保留共享控件和协调网格、侧栏、PiP 的布局规则。运行时代码或已有检查使用的选择器钩子独立于呈现类。
  - `components/conversations/`：共享会话侧栏、标签编辑器和私聊、房间视图组合。Home 提供原地选择回调，历史和交付状态留在共享 store。会话操作区分清除本地历史与删除历史及列表项：清除保留列表项、标签和成员元数据；活动房间和在线私聊允许清除，但离开房间前不能删除，确认时重新检查 presence。私聊操作针对所选会话原本的本地身份。

    `conversation-composer.tsx` 把两类会话绑定到同一提交 API 和 `chat-composer.tsx` 控件。Enter 发送，Shift+Enter 换行，文本最多 65,536 个 UTF-16 code unit。会话内存草稿按 conversation 索引，导航后保留。接受只清除本次提交草稿，重新挂载后也一样，不擦除之后的编辑。所有平台粘贴文本均编辑草稿，剪贴板转发仅作用于输入框外的私聊区域。消息重试共用 pending/error 呈现。
    房间文件卡片挂载时只显示元数据，不读取远端字节。已有本地图片、视频、音频内联显示，因此发送方立即看到自己的媒体，接收方手动或按已启用的小文件自动下载后才显示。房间对话框设置按含命名空间的房间会话保存浏览器本地自动下载权限，默认关闭。传输设置提供应用统一且包含上限值的大小限制，默认 5 MiB；重置房间权限不改变该限制。
    `file-attachment-bubble.tsx` 在私聊、房间消息间共享媒体、元数据和下载呈现。`local-file-media.tsx` 将图片、视频加入各会话 PhotoSwipe，音频使用原生控件。`media-thumbnail.tsx` 保留固定 16:9 框，内层图片边界匹配实际宽高比，视频使用本地首帧海报。
    `media-hash-route.ts` 通过稳定会话、消息 ID 的 `#/media/<encoded-conversation-id>/<encoded-message-id>` 标识预览。打开新增一条历史，切换图片替换它，前进、后退关闭或重开预览；直接加载的深链接在当前页面内关闭。图库显示旧消息窗口并等待本地媒体元数据，不请求缺失房间文件。会议哈希链接选择匹配会话并打开聊天面板。文件变化或视图卸载时释放内联媒体 object URL。
    `file-transfer-indicator.tsx` 把暂停、续传放在紧凑进度环内。传输时速度替换状态文字，暂停、恢复期间元数据保持单行。两种消息适配器保留各自服务调用和房间缓存授权。房间发送方通过下载按钮旁的详情对话框查看接收者下载进度，列表不展开消息气泡。只有接收者能发起、恢复房间下载。

  - `components/dialogs/`：统一对话框目录。
    - 模态原语：`base.tsx`、`dialog.tsx`、`drawer.tsx`。
    - 业务对话框：房间、加入、二维码分享、预览、转发、删除确认、关于、媒体选择、兼容性详情、媒体约束等。
    - `room-info-dialog.tsx`：从房间标题或会话菜单打开，包含房间信息、会议设备、设置和成员标签页。能力、交付详情放在这里，不放在消息输入区上方。历史房间对话框不加入房间，也不改变当前会议设备；打开信息不启动采集。设备页只有选择器，没有采集开关；输出选择只路由已有播放，不主动开始播放。

      成员页合并当前房间实时参与者，以及仍保留私聊记录的历史成员。`RoomService` 使用捕获的房间身份与 generation 校验记录静默加入，私聊元数据保留含命名空间的房间会话 ID。旧历史可通过房间消息发送者和原接收者建立成员关系，但不能假定无关联系人属于房间。删除私聊会把该 peer 从历史成员移除，实时 presence 仍独立可见。可选元数据字段复用现有会话 store，无需提升数据库版本。

    - `ModalProvider` 在 `src/app.tsx` 只挂载一次，对话框工厂自动全局注册；使用方直接调用 `open()`，不在页面 JSX 渲染对话框组件。
    - 路由页面应从此目录导入对话框创建器，不在路由目录另建对话框文件。

  - `components/ui/`：共享按钮、输入框、popover 等 UI 原语。

### 应用逻辑 {#application-logic}

大部分复杂逻辑位于 `src/libs/`，采用明确的分层布局；领域代码不能反向导入应用、状态或基础设施模块：

- `src/libs/state/`：响应式应用状态与面向 UI 的上下文。
  - `app-state.ts`：共享 store 结构，包括房间、客户端视图状态，以及运行时、剪贴板和输入设备能力。
  - `*-context.ts`：UI 使用的稳定上下文契约和 hook。
  - `application-bootstrap.ts`、`application-root.ts`：组件刷新边界外的原生根组合与应用资源所有权。
  - `create-*.ts`：面向 UI 的控制器组合，视图通过 context 或 props 获取现有控制器。
  - `create-app-permissions.ts`：AppState 共享的通知、媒体权限 signal，通过 `useAppState().permissions` 提供。应用根只初始化一次，设置、标题控件和媒体选择器订阅，不在每次挂载重新查询。权限变化、返回页面和显式请求刷新共享结果。设备发现不启动采集，权限观察器随应用作用域释放。
  - `create-app-media-capabilities.ts`：AppState 通过 `mediaCapabilities` 拥有编解码器、采集后端、显示刷新率和音频格式发现。设置、选择器复用快照和进行中的查询，重开视图不使其失效。设备、权限、轨道变化更新相关音频能力，获得焦点刷新显示器信息。浏览器音频格式来自已暴露的输入、轨道能力；Windows 在 process-loopback 客户端验证应用支持的 PCM 组合，不开始录制。浏览器、原生音频编解码器偏好分开。
  - `create-app-settings.ts` 组合共享设置发现。应用和远程键盘设置、远程输入表面、媒体发现都消费同一 `appState.capabilities.runtime` 快照。`create-app-startup.ts` 管理原生启动偏好及待写入操作，`create-app-capture-sources.ts` 保留采集来源列表。获得焦点、显式刷新更新快照，不先清除旧值。关闭设置不丢弃发现状态或启动写入；诊断采集会话和轮询仍随视图停止。
  - `create-app-input-devices.ts`：应用拥有的原生输入设备、驱动检测，通过 `useAppState().inputDevices` 暴露，结果存于 `appState.capabilities.inputDevices`。启动、聚焦、显式刷新共享进行中的工作，失败刷新保留最后成功结果。设置只渲染共享状态，检测不挂起对话框，也不在切入标签页时重启。不请求控制或挂载设备；应用销毁移除监听器并忽略迟到结果。
  - `app-options.ts`、`profile-store.ts`：持久用户配置。`stored-app-options.ts` 只读取当前设置结构，验证嵌套选项，并在持久化前丢弃未知字段。不支持的存储结构使用当前默认值，不迁移开发期设置。当前设备选择即使不可用仍保持可见。
- `src/libs/application/`：应用生命周期与流程编排。
  - `room-service.ts`：管理加入、离开房间，信令客户端生命周期，以及拒绝过期异步加入、会话。创建客户端前预留房间、密码、客户端身份；相同身份并发加入在握手期间共享，身份变化、离开或销毁淘汰旧工作。
  - `session-service.ts`：管理活动 `PeerSession` 实例与客户端视图。
  - `recording-service.ts`：拥有一个 recorder 和连续 VFS 写入器，草稿创建时固定挂载点。浏览器发送、接收 transform 与原生录制适配器实现 `@weblink/platform` 中同一 `EncodedMediaSource` 契约，包含编码视频 access unit、可选编码 Opus/G.722/PCMU/PCMA 或采集 PCM 音频、暂停恢复分段，以及仅订阅范围的清理。浏览器 transform 在 RTP 端点生命周期内一直安装，停止录制只停止复制。

    本地原生录制持有采集范围的编码器池租约，将共享编解码器偏好限制为 AVC/HEVC。匹配的原生硬件观看者复用同一 worker，但保持独立 RTP 反馈与输出端口。录制固定 worker 并使用采集 PCM 音频，观看者离开不能结束任一录制轨道。软件、浏览器编码仍由 WebRTC 管理。
    浏览器会议和原生屏幕观看连接不安装 encoded transform，录制走自动 MIME 选择的 MediaRecorder 与现有流式 remuxer；开始、暂停、恢复和停止时保留原接收轨道，使支持的浏览器可透传编码视频，音频则可能混音、编码。专用编码会议连接在轨道到达前显式选择 `receivePurpose: "recording"`。浏览器原生屏幕接收器直接把观看轨道交给 MediaRecorder。

    接收 delta 帧缺少视频尺寸时，继承该 SSRC 最近已知尺寸；接收关键帧元数据也缺尺寸时，从现有 inbound decode 统计获取，不为探测尺寸另开解码器。复制按字节和包数有界，独立于网络转发。选中单条 Opus、G.722、PCMU 或 PCMA 时可不经音频编码器直接封装。不同音视频 RTP 起点通过共享采集时钟或接收方 RTP、交付时间映射对齐，每个暂停恢复分段固定一次。G.722 的 RTP 时钟为 8 kHz，解码样本为 16 kHz，两种速率都显式跨共享边界传递。固定的 Mediabunny 补丁为这些旧编解码器增加 Matroska A_MS/ACM 封装、解封装，不增加编码器或解码器。

    准备阶段在既定截止时间内等待第一个有效接收音频交付时钟。缺少时钟、不支持的音频编解码器或多音轨时保留音频混合回退，不能静默丢弃音轨。只配对同一连接的匹配轨道；接收方关键帧请求不改变发送码率控制。准备阶段保留从已验证关键帧开始的有界前缀，启动消费此前缀，不再发送可能受 WebRTC 限流的第二次 PLI。
    `recording-encoded.ts` 将已有 VP8、VP9、AV1、H.264、H.265 视频与选定来源音频封装。自动输出对 G.722/PCMU/PCMA 选 MKV 以保留原载荷，否则 AVC/HEVC 用 MP4，其他支持视频用 MKV；参数集验证和 Annex B 转换交给 muxer。此路径无需第二个视频编码器或解码器。不支持码流、缺关键帧、空间层、API 不可用或音频编码器不可用时，在创建 VFS 草稿前回退，不改变发送码率、分辨率策略。回退使用 MediaRecorder：原始本地输入优先支持硬件的容器，接收 WebRTC 输入自动选格式以允许浏览器透传编码帧。实际输出决定最终扩展名，并补齐时长、定位元数据。

    录制容器偏好默认为自动，在开始时固定。发送帧直接进入所选 muxer；显式 MP4 配合 G.722/PCMU/PCMA 时重试现有音频编码回退，同时保留视频复用。MediaRecorder 分块经过有界流式重封装，转换必须复制全部轨道，不引入编解码器；不支持轨道时失败，不能静默丢音频。MKV 的 AVC/HEVC 配置通过公共 muxer、demuxer 从一个关键帧派生，之后 NAL unit 只改变长度封装。
    MKV recorder 保留一个编码视频帧，等待下一呈现时间戳确定其 BlockDuration，以精确处理暂停后的定位。在原生桌面高密度帧段中，文件视频呈现时间采用当前帧及两侧各最多三帧的居中平均值，受相邻采集时间中点限制，减少过短显示间隔而不强制恒定 FPS。每段首尾帧保留采集时间。至少 1/60 秒的间隙、分段变化或字节上限结束该段。只有录制 muxer 缓冲这些帧，音频继续使用原采集时钟。
    VP9/AV1 profile、位深和颜色配置从首个已验证关键帧经同一 muxer、demuxer 读取，不创建解码器。关键帧配置变化会在混入不兼容样本前停止录制；暂停后从原配置的关键帧恢复。

    `crates/desktop-capture/src/media/recording/` 中的原生录制核心管理输入选择、会话生命周期、暂停分段和稳定二进制 IPC 格式，端口提供视频关键帧、生命周期控制、编码音频复制控制和 PCM tap，不导入 Windows、libwebrtc 或 Tauri。后端提供归一到同一单调时钟的音视频时间戳。`media/webrtc/` 的可复用 SDK 适配器提供发送音频观察与 SDK 时钟，目前随 Windows SDK 依赖启用。Windows 适配器管理共享 `hardware` worker，负责 GPU 转换、VFR、码率反馈和有界录制交付；`nvenc`、`mf` 后端共用它，可选 NVENC 初始化或输出失败时保留同编解码器 MF 回退。NVIDIA 驱动 API 通过窄 C++ shim 在运行时加载，WASAPI 采集留在 Windows 适配器。
    关闭录制在下一次打开前释放订阅，即使未完成读取仍持有旧来源。清理释放编码器租约，不关闭其他使用方。

    Windows 原生包录制直接订阅池化的 H.264/H.265 worker，复用匹配 worker 或创建新 worker，不创建本地 peer。连接中的观看传输先收到 access unit，然后才分发到录制 tap；采集、编码线程不执行录制 IPC、封装或文件 I/O。本地录制使用可静音或活动的 WASAPI PCM tap，经共享 muxer 路径编码。音视频共用 WebRTC 单调时钟，独立于观看传输；编码音频端口仍供浏览器发送、接收录制适配器使用。
    同时最多一个二进制读取在途，队列溢出终止录制，不改变原发送器。不支持的原生来源保留本地接收器、MediaRecorder 回退，包括真实来源音频。每次恢复等待关键帧，并从两条轨道中移除暂停时长。
    Web 观看者直接从接收轨道录制原生屏幕，开始、暂停、停止都是本地操作。自动 MIME 允许 Chromium 复用接收视频；单条选中屏幕音轨直接交给 MediaRecorder，多轨使用混音器。Chromium remuxer 根据观察到的 Opus 包时长，以及同一次 WebRTC stats 报告中两轨估算播放时间之差，一次性对齐 Opus 与视频。双方 RTCP sender report 到达前，可使用 Windows 音视频 RTP 的可选 Absolute Capture Time 扩展；两种时钟都没有时，只按观察到的 Opus 包时长对齐。文件保留连续音频包之间的相对时序，并平滑高帧率视频呈现。
    采集关闭、借用远端来源断开或视频配置变化会完成当前文件，本地包录制的观看者离开不会。原生包录制遇到不兼容音频格式或缺采集时钟时以错误停止，不拼接不兼容流。停止会排空已接受包和 muxer 最后写入，再通过 VFS close 应用有界元数据补丁。录制从不停止会议借用的视频、音频轨道。

  - `ice-server-diagnostics.ts`：通过可注入的凭据、探测函数协调 STUN/TURN 可用性，无 UI 或共享状态所有权。
  - `messaging/`：响应式消息历史、持久化端口和受跟踪消息流程，IndexedDB 实现不在此层。
    - `message-store.ts`：共享消息历史及恢复、稳定响应式数组、浏览器本地消息序号，以及从注入的会话元数据和持久消息 store 组合出的共享外观接口。加载历史时，中断的私聊、房间发送变为可重试失败。
    - `conversation-history-service.ts`：缓存本地文本会话的应用 API，等待恢复、创建记录和稳定消息 ID、合并并发批次，并续写未完成操作而不重复。调用方提供内容，不提供存储记录。欢迎指南复用此 API，仅持久化成功后标记完成。
    - `conversation-store.ts`：本地会话元数据、标签和阅读游标。私聊、房间历史按会话身份查询、删除；删除联系人不删除其发送的房间消息。
    - `conversation-message-store.ts`：两类会话的持久插入、不可变重复身份检查及串行交付、进度写入。新消息仅在持久化成功后发布。清空或删除会话使待处理插入失效，迟到写入不能恢复已删除历史。文件续传请求可携带新请求时间戳，但必须保留原文件身份。
    - `conversation-messaging-service.ts`：共享 UI 发送、重试入口，验证所选会话、本地身份和当前目标。`message-submission.ts` 区分本地持久接受与网络完成；两条路径都从已持久化接收者结果派生完成状态，包括房间部分交付失败。接受后的交付失败属于消息，只有接受前失败才保留草稿。重试重新解析存储消息并复用 ID。私聊只有一位接收者，房间保留原接收者快照。`message-delivery.ts` 将接收者结果投影到历史顶层状态，并在重新加载时恢复中断交付。
    - `peer-messaging-service.ts`：私聊协议适配器，包括文本接收。私聊发送和传入 ACK 与房间消息一样等待持久历史。文件字节传输状态独立于 offer 交付成功，之后二进制通道失败不撤销 offer ACK。
    - `conversation-query.ts`：两个侧栏使用的纯摘要、搜索、标签过滤与分组投影。文本和标签选择按 AND 组合，多个选中标签按 OR。会话可出现在多个标签组，但未读总数每会话只计一次。消息顺序、最近活动和阅读游标使用持久本地序号，发送时间仅作显示元数据，远端时钟偏差不会在重开浏览器后重排已读历史。
    - `room-messaging-service.ts`：能力协商、一条逻辑房间消息及在线接收者快照、逐接收者结果，以及只重试原失败接收者。会话、房间生命周期检查防止迟到操作进入替代房间。没有离线发件箱或晚加入历史同步。
    - `room-file-sharing-service.ts`：准备本地附件，经房间消息服务发布 offer，对照原 offer 和当前房间绑定授权显式接收者下载。每次获取使用新协议请求 ID，进度归属持久 offer。已启用的小文件自动下载复用同一路径。房间持久化报告 offer 是否新插入，只有新鲜、已验证的传入 offer 才触发大小检查；历史、重复回执、暂停、失败和完成传输不会再启动下载。检查使用原存储元数据，不延迟元数据 ACK。
  - `room-identity.ts`：派生房间会话身份使用的信令命名空间，让不同信令服务上的同名房间分开。
  - `rtc/`：Weblink 的 PeerSession 传输适配器与协议组合；可复用 P2P 协议位于 `domain/protocol/`。
  - `transfer/`：文件流程、注册表和消息绑定。`file-offer-transfers.ts` 为房间附件复用运行、通道所有权，不创建私聊消息。上传进度逐接收者保存，交付回执只说明 offer 交付，不说明二进制完成。某个接收者完成后仍保留房间附件缓存，附件 ID 继续排除在旧私聊 request/resume 路径之外。共享内容使用独立目录引用，包括房间中发送的内容；显式本地转发以新 ID 创建由共享不可变内容支持的私聊附件，不让原房间缓存通过私聊请求访问。

    私聊、房间和共享文件二进制运行协商 `files.queue` 与可选 `queue` 请求标记。注册表先确认建立再等待，通过一个 FIFO 队列接纳运行，默认并发 3，可调 1–10。按 client ID 顺序取得两端槽位，双方都预留后才初始化 worker；接收方先安装处理器才允许字节。排队时间不计入请求、通道截止时间，槽位保留到验证结束，在完成、取消或断开时释放。调低上限时让已有运行逐步排空。旧 peer 和交互式剪贴板、拖放 RPC 保留原启动行为，计入占用但不等待接纳。

  - `file-library-service.ts`：内容寻址存储所有权、独立附件引用、显式文件库保留，以及旧完整缓存的惰性索引。元数据数据库 `weblink-file-library-v1` 索引 BLAKE3-256 身份，二进制数据由底层文件存储管理。待处理导入只有字节提交后才发布。逐内容 Web Locks 协调标签页，唯一声明和恢复记录防止重复写入。`files/reference-chunk-cache.ts` 用各附件自己的名称、权限、分块大小读取共享字节。删除消息只释放引用；文件管理器显式删除会取消受影响运行并移除全部本地引用，但保留聊天元数据。固定保留的导入不会被消息清理删除。
  - `file-fingerprint-service.ts`：一个增量 BLAKE3 Worker，以 2 MiB 读取，为同一 Blob 对象共享任务，支持取消和任务中心进度。仅文件元数据不能授权去重。首次使用旧完整缓存时计算指纹，不阻塞应用启动。
  - `transfer/file-content-capabilities.ts`：通过会话范围的能力协商 `file-content-v1`。新 offer 使用类型化 `have` / `need` / `deferred` 响应；含指纹的房间文件 offer 使用版本 2。未确认 peer 继续使用旧 envelope。`have` 仅在历史持久化和本地引用可读后返回，不创建二进制运行。Deferred 本地任务共用一个已授权来源，`file-content-ready` 在各等待 offer 原身份与房间绑定下可靠完成它。二进制接收方在发出完成前验证已解压、已组装内容，损坏字节不进入内容索引。本地完成携带 `completionSource: "local"`，不伪造吞吐量。
  - `file-catalog-index.ts`：完整、显式共享的内容引用，以及内存搜索、排序、分页查询，分页不读取 File 内容或存储。
  - `transfer/shared-file-transfers.ts`：已授权目录获取、独立任务生命周期和本地文件库引用，不产生聊天消息；与聊天附件共享二进制注册表及指纹接收协调器。关闭文件面板取消目录视图，不取消传输。
  - `file-catalog-service.ts`：版本 3 目录 provider、隐私策略和无载荷 P2P 失效通知路由。
  - `remote-file-catalog.ts`：活动页刷新合并、取消和过期响应隔离。`hooks/file-catalog.ts` 中的 Solid hook 绑定侧栏文件页当前成员。查询状态属于视图，默认每页 50 文件，隐藏视图释放订阅。
  - `cache-service.ts`、`speed-test-service.ts`、`task-service.ts` 等：应用范围协调器。

- `src/libs/domain/`：底层模型与 P2P 行为，不得导入 `application`、`state` 或 `infrastructure`。
  - `client.ts`、`ids.ts`、`file.ts`、`message.ts`、`conversation.ts`：共享领域模型与契约，不拥有应用状态。会话身份独立于活动 peer 会话，私聊标识原始双方 client ID，房间会话标识信令命名空间和 room ID。标签、阅读游标是本地分类元数据，不是房间成员关系或远端共享设置。
  - `session.ts`、`peer-negotiation.ts`、`signaling.ts`：WebRTC 会话与信令服务契约。`session-lifecycle.ts` 在同时恢复时保留一个首次 offer 所有者。Polite 端被动尝试失败但信令仍可用时，会主动尝试一次，避免恢复依赖另一端发现失败。从隐藏恢复可见，即使没有 `freeze` 事件，也可重试失败会话。可用性事件保留健康连接，失败后等待新事件，不运行轮询循环。
  - `native-screen/session.ts`：已认证原生媒体通道、能力协商、传入屏幕与视图身份。`media-publication.ts` 管理每个传出发布的 offer、ICE、重试预算和清理，保留的接收者身份不随关闭、待处理传输丢失。`native-screen/signaling.ts` 管理兼容新增线上消息与解析器，`native-screen/receiver.ts` 管理浏览器只接收 RTC 和接收器契约。`application/media-receive-service.ts` 选择可选平台接收器并拥有能力、失败策略。Windows 接收位于 `crates/desktop-capture/src/receive.rs`，`apps/desktop/src/receive.ts` 通过现有 MediaStream UI 呈现有界原生音视频。

    各平台提供 `RoomTransport` 工厂，房间建立、重连使用 `RoomConnection` 接口处理协商、轨道和 DataChannel。浏览器返回自己的 RTCPeerConnection；Windows 由 `crates/desktop-capture/src/room_peer.rs` 管理每个远端成员的 ICE、DTLS、RTP、SCTP。`apps/desktop/src/room` 适配器把信令、DataChannel 和设备采集桥接到房间会话。普通会议轨道使用协商的 MID，`domain/room-screen.ts` 将原生屏幕轨道、输入通道关联到该连接上已认证的发布。`application/meeting-camera-peer.ts` 服务于与旧专用摄像头接收器互操作的浏览器发送方。`native-screen/decode-monitor.ts` 观察前台解码进度。

  - `signaling-protocol.ts`：与传输无关的 WebSocket 信令 envelope、presence、peer 路由消息、加入确认，以及跨客户端实现所需已部署版本和限制。
  - `protocol/`：与传输无关的 P2P 控制线上契约、运行时校验、请求响应状态机及最小传输、会话端口，无 PeerSession、WebRTC、Solid、IndexedDB 或 AppState 依赖。
  - `transfer/protocol.ts`、`transfer/packet.ts`：可移植文件通道 JSON 帧和精确二进制块头。发送、接收算法仍是围绕契约的 WebRTC、浏览器领域代码。应用把连接协商的 SCTP 消息上限传给文件发送器，载荷块不超过上限减七字节头；缺少上限时使用保守的 64 KiB 整包预算。线上头和分块身份不变。
  - `speed-test-protocol.ts`：带版本的 `weblink-speedtest-v1` 控制 DTO、解析器和限制；`speed-test.ts` 管理 WebRTC 诊断状态机。
  - `transfer/`：分块文件发送、接收器及传输拥有的 worker。

- `src/libs/infrastructure/`：具体浏览器、后端适配器。
  - `signaling/`：WebSocket 客户端、传输实现。
  - `vfs/`：统一文件存储、IndexedDB 与目录存储卷，以及旧缓存迁移；文件缓存和恢复规则见[本地文件存储](../reference/file-storage.md)。
  - `storage/`：IndexedDB 元数据与消息历史仓库适配器。`indexeddb-message-repository.ts` 管理显式版本 2 消息 schema、旧私聊回填、会话索引、会话与标签元数据存储，以及原子移除会话历史或标签关联。房间 ACK 在本地持久插入后返回，重复逻辑消息在重新加载后仍幂等。历史恢复时，中断房间交付变为可重试失败，不静默重启网络工作。
- `src/libs/hooks/`：UI 使用的 Solid hook。`conversation-read.ts` 仅在 document 可见、挂载会话跟随最新消息时推进共享本地阅读游标；`create-bottom-scroll.ts` 分别管理各会话滚动视口，与路由、document 滚动分离。
- `src/libs/utils/`：通用工具。Worker 模块放在各自所有者旁，不集中到全局 worker 目录。

## 数据流概览 {#data-flow-high-level}

1. UI 调用 `AppStateContext` 的函数，定义位于 `src/libs/state/app-state-context.ts`。
2. 上下文把流程委托给 `src/libs/application/*`。
3. 应用服务创建、管理 `src/libs/domain/*` 原语，在需要浏览器、后端实现时选择 `src/libs/infrastructure/*` 适配器。
4. 应用服务把底层事件转换回 `src/libs/state/app-state.ts` 中的 `appState`。

应用编排仍使用共享 Solid store，尚不是独立于框架的层。当前严格可移植边界专门适用于 `domain/protocol`，不适用于整个应用或 WebRTC 领域。本地媒体流与面向 UI 的控制器由 `src/libs/state/application-root.ts` 组合，通过原生 Solid 上下文作用域注入。
普通 TypeScript 入口 `src/bootstrap.ts` 与组合层位于组件刷新边界之外，拥有初始化、本地采集、房间服务、音频、会议状态和对话框控制器；`src/app.tsx` 拥有其视图。替换视图只脱离 DOM 绑定，不销毁应用服务。音频元素替换时，绑定会恢复选中的输出设备。

上下文定义、hook 与 provider 视图、工厂实现分开。本地视频、视频块操作、motion 和 grid 作用域从 `view-scopes.ts` 获取上下文身份，每个视图仍提供自己的作用域值。定义、组合变化通过普通 import 到达入口并触发原生页面重建；视图变化使用 Solid refresh，保留现有应用所有者。新上下文必须遵循这一所有权边界，不能在热更新组件模块中创建。

## 信令与资料隐私 {#signaling-and-profile-privacy}

新 client ID 使用 `uid_` 加 16 个密码学随机的 URL 安全字符，提供 96 位随机性。已保存资料保留原 ID，包括旧 UUID，使本地会话身份在升级、重新加载后稳定。

信令后端是连接会合层，不是应用消息传输层：

- 客户端只发布 `clientId`、`createdAt`、支持的 RTC 资料版本与重连元数据；信令 presence 不含 `name`、`avatar`。
- WebRTC 消息 DataChannel 就绪后，通过带版本的 `client-profile` 发送显示名称与头像，通道重连时再次发送。
- WebSocket 客户端忽略旧 presence 资料字段，WebRTC 资料抵达前在本地使用匿名占位。
- peer 连接建立前，SDP offer/answer 与 ICE candidate 仍须通过信令；房间成员关系和 client ID 也仍对信令后端可见。

## 事件订阅与所有权 {#event-subscriptions}

`@weblink/platform/events` 提供 Web 服务和桌面适配器共用的类型化订阅契约。服务通过 `events.subscribe(topic, receive, { signal, once })` 暴露事件，回调直接接收对应载荷，每次订阅返回可重复调用的取消函数。事件保持同步、按顺序分发。每个服务或会话持有自己的 `EventBus`，按信令、会话、传输、文件、自动化和窗口可见性划分业务域；消费方只获得订阅接口，发布权归所有者。没有全局消息总线或共享事件名称注册表。

`RtcService.events` 分发应用层消息、通道和会话关闭事件；其 `transport` 将这些事件适配到可移植的 `ProtocolTransport` 契约，协议模块继续独立于平台和 UI 订阅代码。

`SubscriptionScope` 统一管理订阅和其他清理函数。将其 `signal` 传给领域订阅或 DOM 监听器，通过 `add` 登记同步清理，通过 `track` 接管异步原生监听注册。作用域关闭后才完成的注册会立即释放，`guard` 会拦截关闭后到达的回调。房间替换、会话关闭和视图清理各自释放所属作用域；所有者先发布最后的关闭或完成事件，再释放总线。

业务事件统一使用载荷订阅，无需 DOM 事件封装或手动匹配回调。即使回调相同，每次订阅也有独立的生命周期。原生 IPC、BroadcastChannel 和 WebRTC 监听留在各自适配器内。事件描述变化，Solid store 仍负责 UI 状态。消费方订阅变化后按需读取当前快照，文件存储迁移进度也遵循这一方式。自动化保留初始快照、epoch/revision 检查和初始化前的通知队列；协议消息、权限判定和必要的心跳、重试定时器保持现有语义。

## 设计约定 {#design-conventions}

- WebRTC 细节留在 `src/libs/domain`。优先从 `AppStateContext` 暴露应用级方法，不在 UI 构造协议、消息对象或导入应用单例。
- 功能内部常量靠近实现，只有跨多个模块、层使用或需一致调节时才放入 `src/constants.ts`。
- 监听器生命周期优先使用 `AbortController`，避免泄漏 interval 和监听器。
- 协议、上下文 API、服务接口等模块边界使用明确类型。
