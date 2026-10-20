<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/branding/weblink-logo-dark.svg" />
    <img src="apps/web/public/branding/weblink-logo-light.svg" alt="Weblink" width="300" height="96" />
  </picture>

  <h3>分享更多，安装更少。</h3>

  <p>
    一个基于 WebRTC 的工作空间，集成聊天、文件共享、语音、视频和远程控制。
    可直接在浏览器中使用，也可运行桌面客户端。
  </p>

  <p>
    <a href="https://webl.ink"><strong>打开 Weblink</strong></a>
    ·
    <a href="docs/README.md">文档</a>
    ·
    <a href="README.md">English</a>
  </p>

  <p>
    <a href="https://github.com/99percentpeople/weblink/actions/workflows/ci.yml">
      <img src="https://github.com/99percentpeople/weblink/actions/workflows/ci.yml/badge.svg" alt="CI" />
    </a>
    <img src="https://img.shields.io/badge/WebRTC-P2P-5b5bd6" alt="WebRTC P2P" />
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  </p>
</div>

---

## 用浏览器控制桌面

在手机或电脑的浏览器中连接桌面客户端，即可查看远程画面、操作鼠标和键盘，并传输文件。
Weblink 还提供聊天、本机文件库、语音视频通话和屏幕共享，设备之间通过 WebRTC 连接。

Web 版无需安装原生客户端。桌面版复用相同的界面与应用代码，
并提供原生屏幕采集、远程输入、系统剪贴板访问和桌面窗口管理能力。

## 开始使用

1. 打开 **[webl.ink](https://webl.ink)**，或启动桌面客户端。
2. 设置显示名称和房间 ID，也可以为房间设置密码。
3. 在另一台设备上使用相同密码加入该房间，也可通过房间链接或二维码邀请他人。
4. 打开房间群聊或成员私聊，发送文件，或开启麦克风、摄像头和屏幕共享。

如需远程控制，在被控电脑上运行桌面客户端，再从另一台设备的成员或显示器画面操作中请求控制。
被控端批准请求或已保存允许规则后即可控制；尚未共享显示器时，批准请求可以启动共享。
窗口共享仅支持观看。

可从 [GitHub Releases](https://github.com/99percentpeople/weblink/releases/latest)
下载 Windows x64 安装包或便携版 ZIP。安装包会在需要时安装 WebView2；
便携版需要 WebView2 120 或更新版本，并保留可执行文件旁的 `weblink-portable` 标记文件。
开发版可从 [CI 构建](https://github.com/99percentpeople/weblink/actions/workflows/ci.yml)
获取 `weblink-windows-x64` 可执行程序产物。
运行环境与源码构建方式见[桌面端说明](docs/DESKTOP.md)。

## Web 与桌面端能力

| 功能                     | Web 版                                 | 桌面版（当前支持 Windows）             |
| ------------------------ | -------------------------------------- | -------------------------------------- |
| 房间、私聊、文件库与传输 | 支持                                   | 支持                                   |
| 文件存储                 | 默认 IndexedDB；受支持浏览器可挂载目录 | 默认本地目录，也可使用 IndexedDB       |
| 摄像头与麦克风           | 浏览器设备 API                         | WebView 设备 API                       |
| 屏幕共享                 | 浏览器支持的采集能力                   | 原生显示器、窗口采集及受支持的系统音频 |
| 录像                     | 单个本地或远端来源，支持暂停与继续     | 相同操作，支持原生共享画面             |
| 远程控制                 | 控制兼容的桌面客户端                   | 控制其他被控端，或允许本机被控制       |
| 画中画                   | 浏览器提供的画中画 API                 | 可缩放的原生置顶窗口                   |
| 系统集成                 | 受支持环境下的 PWA 安装与系统分享入口  | 托盘、开机启动、关闭行为及原生通知     |

桌面端当前支持 Windows 10 22H2 / Windows 11 x64，需要 WebView2 120 或更新版本。
原生系统音频和输入功能取决于操作系统能力。
浏览器媒体采集、剪贴板、通知和 PWA 功能取决于浏览器支持及权限；
浏览器采集请使用 HTTPS 或 localhost。

## 主要功能

### 会话与房间

- 成员私聊与在线房间群聊，支持文字、文件附件、转发、送达状态和本机历史记录。
- 会话搜索、标签和活动排序，以及保存连接信息的最近房间选择。
- 按客户端和房间管理远程控制请求、共享文件访问与自动下载设置。
- 消息、远程控制请求、测速请求和传输完成通知，可配置内容预览与声音；
  Windows 通知支持直接回复和批准请求。

### 文件库与传输

- 通过文件选择器或拖放导入文件和文件夹，从聊天或文件库发送、转发文件；文件夹打包为 ZIP。
- 查看进度、暂停、继续、重试或取消传输，复用已缓存分片和本机已有内容。
- 按内容去重的本机文件库，提供明确的共享开关，以及跨房间共用的共享文件清单。
- 搜索、排序、预览和批量下载在线成员的共享文件；下载直接进入文件库与任务列表，不产生聊天消息。
- 群聊文件默认按需下载，可按房间开启小文件自动下载，并在传输设置中统一配置大小上限。
- 在文件存储设置中选择浏览器存储或实际目录。Web 默认使用 IndexedDB，桌面端默认使用本地目录；
  支持目录选择的浏览器可在授权后挂载目录，目录变化会同步到文件库。
- 自动迁移旧 IndexedDB 文件与断点续传分块，显示迁移进度，仅在新数据校验成功后删除旧文件数据库。
- 文件预览支持缓存的视频缩略图。IndexedDB 文件使用“保存到设备”，目录文件使用“另存为”；
  Windows 还可打开文件所在位置并在资源管理器中选中。
- 批量另存为只选择一次目标目录，遇到同名文件可覆盖、跳过或保留两份，并将选择应用到全部。
  导入和保存均提供进度与取消操作，关闭文件缓存对话框后仍会继续处理。

仅导入或接收文件不会自动共享；新发送的文件会自动开启共享，之后可在文件库中关闭。
对端仅能在文件列表访问权限允许时，浏览完整且已开启共享的内容。

更换默认存储仅影响新文件，已有文件、正在传输的文件和录像保留原存储位置。
目录中的未完成文件使用 `.part` 后缀，不能预览或共享。浏览器拒绝文件名时，
目录存储可在磁盘文件名后添加 `.weblink`，在 Weblink 列表和传输中仍保留原文件名。
浏览器目录访问与批量保存依赖目录选择 API 和授权，刷新页面后可能需要重新授权。

### 会议与屏幕共享

- 共享摄像头、麦克风和多个屏幕，支持网格或主画面布局、固定画面、全屏、画中画与独立音频控制。
- 在会话中调整分辨率、帧率和码率，并选择当前设备与运行环境支持的音频格式。
- Windows 提供显示器和窗口预览、DXGI 与 Windows Graphics Capture 采集，
  可选择可用的软件编码器或 H.264/HEVC 硬件编码，高帧率选项跟随已连接显示器的刷新率。
- 受支持的 Windows 硬件编码器直接接收 GPU 纹理，避免帧数据经 CPU 回读后再次上传。
  自动选择优先匹配捕获显卡上的编码器，不支持时保留内存输入回退；
  软件与硬件编码共用静止画面的可变帧率调度。
- 兼容的 NVIDIA 显卡优先使用原生 NVENC 进行 H.264/HEVC 编码，
  不可用或运行失败时回退到 Media Foundation；Intel、AMD 使用各自可用的
  Media Foundation 编码器。串流统计显示实际使用的编码实现。
- 本地预览复用读回缓冲区，按新帧通知更新；隐藏预览时暂停本地呈现，远端串流继续运行。
- 在应用内查看媒体流统计、ICE 路由与连接状态，并进行对端吞吐测速。

HEVC 需要兼容的硬件编码器及在 WebRTC 中支持 H.265 的接收端。
原生屏幕传输当前采用 8 位 SDR YUV 4:2:0，应用会按实际能力提供采集与编码选项。
详见[原生媒体说明](docs/DESKTOP.md#native-screen-sharing)。

### 录像

- 选择一个本地或远端摄像头、共享画面进行录像，仅包含该来源关联的声音。
  从画面菜单开始录像，在页头状态中暂停、继续或停止并保存。
- 暂停后继续写入同一个文件。关闭菜单或文件缓存对话框不会停止录像，
  来源结束或离开会议时自动结束录像并保存。
- 持续写入开始时选定的存储位置。文件库中显示一个未完成项，
  正常结束后补齐时长和定位信息，登记为完整文件。
- 保存成功后通过共用通知流程提醒，点击可在 Web 中预览，或在桌面端使用系统默认程序打开；
  前台提示与后台系统通知遵循统一设置。
- 优先复用串流中已有的音视频编码，避免重复编码。Web 与桌面端共用这一流程，
  无法复用时保留 MediaRecorder 与原生音频回退；有上限的录像队列避免慢速存储阻塞正常串流。
- 设置中可选择自动、MKV 或 MP4。自动模式下，H.264/H.265 使用 MP4，
  其他受支持的视频编码使用 MKV；复用 G.722、PCMU 或 PCMA 音频时也使用 MKV，以保留原始音频编码。

录像能力取决于浏览器 API 和来源编码，外部播放器需支持所选容器内的具体编码。
浏览器目录在录像结束时可能仍需时间完成保存；崩溃或强制关闭后的未完成录像不保证可播放或恢复。

### 远程控制与剪贴板

- 通过鼠标和键盘控制 Windows 显示器共享，支持同步光标外观、自定义输入释放快捷键和被控端紧急撤销快捷键。
- 移动端支持触控板手势、直接多点触控、软键盘与输入法、可配置采样率，以及跟随远端文本焦点显示或隐藏键盘的选项。
- 可开启文本、富文本、图片与文件的远程剪贴板同步；根据客户端能力，将复制的文件写入本机剪贴板或文件库，文件夹以 ZIP 传输。
- 可开启远程文件拖放，将本地文件拖入远程画面中的兼容 Windows 应用。
  当前支持向远程电脑复制文件，不支持从远程窗口拖出文件到控制端操作系统。

剪贴板同步和远程文件拖放默认关闭，需要有效的远程控制授权。
两者共用单次文件大小限制，默认 64 MiB，可设置为 1–512 MiB。
被控端可批准或拒绝请求、记住客户端权限，并随时在本机撤销控制。
详见[远程控制说明](docs/DESKTOP.md#attended-remote-control)。

## 连接与本机数据

```mermaid
flowchart LR
    A[客户端 A] -->|加入房间 / SDP / ICE| S[信令服务]
    B[客户端 B] -->|加入房间 / SDP / ICE| S

    A <-->|WebRTC 数据 / 媒体| B
```

浏览器与桌面端均通过 WebSocket 信令发现对端、管理房间成员并完成 WebRTC 协商。
消息、文件、远程输入和音视频通过 WebRTC 通道传输；无法直连时，可通过 TURN 中继加密流量。

房间密码用于保护协商过程中的信令内容。显示名称和头像通过 WebRTC 交换，
不作为信令在线信息公开。信令服务不保存聊天记录或文件。

群聊消息仅送达当前在线成员，服务器不提供离线消息投递。
聊天历史、文件元数据与偏好保存在本机浏览器或桌面 WebView 的存储中，
文件内容保存在 IndexedDB 或选定的本地目录中。
浏览器和桌面端的应用数据相互独立，不会自动同步。获取对端共享文件时，对端需要保持连接。

## 共用代码与版本

SolidJS + TypeScript 应用位于 `apps/web`，`apps/desktop` 中的 Tauri 客户端
使用相同前端并在构建时接入桌面适配器。平台契约位于 `packages/platform`，
原生采集与输入实现位于 `crates`。

Web 与桌面端统一使用 `apps/web/package.json` 中的应用版本。
“关于”、复制的版本信息、构建元数据和桌面安装包均使用这一版本。
Windows 稳定版可在设置 → 关于中手动检查更新，也可开启启动时和每小时自动检查。
安装版支持校验签名后由用户确认更新；便携版提供对应 ZIP 的下载入口，由用户手动替换。
检查更新不会自动下载或安装。

## 自部署

可以托管 Web 静态构建产物，或使用仓库内的 Docker 配置，并接入 WebSocket 信令服务：

- [weblink-ws-worker](https://github.com/99percentpeople/weblink-ws-worker)：
  基于 Cloudflare Workers + Durable Objects，公开服务使用此实现。
- [weblink-ws-server](https://github.com/99percentpeople/weblink-ws-server)：
  基于 Bun，适合自部署和局域网使用。

按网络需要配置 STUN/TURN，信令服务须支持 v2 入房确认。
托管、环境变量、托管 TURN 凭据和局域网 HTTP 行为见[部署说明](docs/DEPLOYMENT.md)。

## 本地开发

使用根目录 `package.json` 固定的 Bun 版本（当前为 1.4.2）：

```sh
git clone --recurse-submodules https://github.com/99percentpeople/weblink.git
cd weblink
bun install --frozen-lockfile
cp .env.example .env
bun dev
```

上述命令同时启动 Web 应用和本地 Bun 信令服务，端口及本地信令地址在 `.env` 中配置。
已有仓库请先运行 `git submodule update --init --recursive` 初始化子模块，再安装依赖。

开发桌面端前，先按[桌面开发说明](docs/DESKTOP.md)安装 Windows 构建依赖。
若 `bun dev` 已在运行，可直接复用其信令服务；否则在一个终端中启动本地信令服务：

```sh
bun --env-file=.env run dev:server
```

再从另一个终端启动桌面应用：

```sh
bun --env-file=.env run dev:desktop
```

常用检查与构建命令均在仓库根目录运行：

```sh
bun run lint
bun run test:unit
bun run test:integration
bun run build
bun run check:desktop
bun run build:desktop --bundles nsis
```

NSIS 安装包须在 Windows 上构建。仓库结构见[工作区文档](docs/WORKSPACE.md)，
针对性检查与测试边界见[测试说明](docs/TESTING.md)。

## 了解更多

- [文档索引](docs/README.md)
- [架构说明](docs/ARCHITECTURE.md)
- [桌面功能与开发](docs/DESKTOP.md)
- [P2P 协议](docs/P2P_PROTOCOL.md)
- [文件传输协议](docs/FILE_TRANSFERS.md)
- [部署说明](docs/DEPLOYMENT.md)
- [更新日志](CHANGELOG.md)
- 媒体依赖说明：[Mediabunny](apps/web/public/licenses/mediabunny.txt) 和
  [NVENC 接口](apps/web/public/licenses/nvcodec.txt)

使用过程中如有问题，也可以加入 QQ 群反馈：
[762463759](https://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=5MRpXPQN4vGtiLnTzCUb-NlAK9txeEoE&authKey=Gm3OmhI6g3ccmNx8rXVcPsbmEzsoBcj%2FpF%2FOlq7edcbMxTlhPLipZ6i9fwsPCsLt&noverify=0&group_code=762463759)。

---

<div align="center">
  <strong>Weblink</strong><br />
  用浏览器控制桌面，分享文件与实时画面。
</div>

## 自动化

支持 WebMCP 的浏览器与桌面端标准 MCP 服务共用工具目录，提供授权控制、Shell 任务和串流诊断。可在「设置 → 自动化」启用，详见[自动化与权限](docs/AUTOMATION.md)。
