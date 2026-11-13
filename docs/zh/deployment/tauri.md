# Tauri 端部署

在需要原生屏幕共享、远程控制、文件访问或 MCP 自动化的电脑上部署 Windows 桌面客户端。当前支持 Windows 10 22H2 / Windows 11 x64，需要 WebView2 120 或更新版本。

桌面应用内嵌前端，每台电脑运行自己的客户端并连接信令后端，无需将桌面端文件托管到 Web 服务器。先部署 [Server](backend.md) 或 [Worker](worker.md) 中的一种；如果还需要浏览器访问和网页邀请链接，再按 [Web 端部署](hosting.md)搭建网页入口。

## 使用现成的桌面安装包 {#existing-package}

如果只是连接自己的后端，可以直接使用现成客户端：

1. 从 [Weblink 下载页](https://github.com/99percentpeople/weblink/releases/latest)获取安装包或便携 ZIP。
2. 运行安装包，缺少 WebView2 时会安装。便携版需先完整解压，保留可执行文件旁的 `weblink-portable`，缺少 WebView2 时自行安装。
3. 打开“设置 → 连接 → WebSocket 信令服务器”，填写自己的地址，例如 `wss://signal.example.com`，然后保存。
4. 在另一个客户端使用相同的信令服务、房间 ID 和密码加入。

修改信令设置不会改变安装包内的网页邀请链接默认地址。需要将自己的信令和公开网页地址作为默认值打包时，按下面的步骤构建。日常操作与更新说明见[桌面端使用](../guide/desktop.md)。

## 准备 Windows 构建环境 {#requirements}

使用 Windows x64 电脑，安装：

- Git 和 Bun，Bun 版本与根 `package.json` 的 `packageManager` 一致。
- 通过 rustup 安装 Rust，由仓库的 `rust-toolchain.toml` 选择所需工具链。
- Visual Studio C++ Build Tools，勾选“使用 C++ 的桌面开发”，安装 MSVC 14.44（Visual Studio 2022 17.14）或更新版本，以及 Windows SDK 10.0.26100 或更新版本。
- WebView2 120 或更新版本。安装方法见 [Tauri Windows 环境准备](https://v2.tauri.app/start/prerequisites/#windows)。

**当前源码构建需要读取 Cargo 固定依赖使用的私有原生 SDK 仓库。** Git 必须有权拉取这些依赖，首次下载原生 WebRTC 库还需要已登录的 GitHub CLI（`gh`）。仅克隆公开源码不足以完成桌面端编译。没有 SDK 权限时，使用上面的现成客户端；Web、Server 和 Worker 部署不依赖该 SDK。

安装工具并具备 SDK 访问权限后，在 PowerShell 执行：

```powershell
gh auth login
gh auth setup-git
git clone --recurse-submodules https://github.com/99percentpeople/weblink.git
cd weblink
bun install --frozen-lockfile
rustup show
rustup target add x86_64-pc-windows-msvc
```

已有源码时，在仓库根目录运行 `git submodule update --init --recursive` 和 `bun install --frozen-lockfile`。后续命令也从仓库根目录执行。首次原生构建需要下载依赖，通常比之后的构建耗时更长。

## 配置打包后的客户端 {#configuration}

创建桌面端专用环境文件：

```powershell
Copy-Item apps/web/.env.example apps/web/.env.desktop.local
```

编辑 `apps/web/.env.desktop.local`，替换示例域名：

```dotenv
VITE_WEBSOCKET_URL=wss://signal.example.com
VITE_SHARE_URL=https://web.example.com
WEBLINK_STUN_SERVERS=stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302
```

| 配置                   | 用途                                                                                          |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| `VITE_WEBSOCKET_URL`   | 默认信令地址。打包客户端访问非回环地址时必须使用 `wss://`；同机测试可用 `ws://127.0.0.1:9000` |
| `VITE_SHARE_URL`       | 房间邀请链接和二维码使用的公开 Web 前端地址，需单独部署该站点；不会改变应用内嵌前端或信令地址 |
| `WEBLINK_STUN_SERVERS` | 逗号分隔的 STUN 地址                                                                          |
| `VITE_TURN_SERVERS`    | 可选的自定义 TURN 中继，格式见 [STUN 与 TURN](hosting.md#stun-and-turn)                       |

Tauri 构建使用 Vite 的 `desktop` 模式。下方命令通过 Bun 的 `--env-file` 显式加载桌面配置，避免已有 `apps/web/.env.local` 中的 Web 端配置意外成为默认值。已有进程环境变量仍然优先。根目录 `.env` 用于组合本地开发，不配置打包客户端。

这些值在**构建时**写入安装包，修改后需要重新构建并安装。用户保存的连接设置优先于安装包默认值；需要使用新默认值时，在对应设置项中重置。

客户端配置在构建产物中可见。`TURN_KEY_ID` 和 `TURN_KEY_API_TOKEN` 只配置在 [Server](backend.md#turn) 或 [Worker](worker.md#turn) 上，客户端会自动从后端获取临时凭据。

## 构建安装包或可执行文件 {#build}

构建 Windows x64 NSIS 安装包：

```powershell
bun --env-file=apps/web/.env.desktop.local run build:desktop --target x86_64-pc-windows-msvc --bundles nsis
```

命令会先构建桌面前端，再编译原生应用。使用默认输出配置时，产物位置如下：

| 产物             | 位置                                                        |
| ---------------- | ----------------------------------------------------------- |
| 安装包           | `target/x86_64-pc-windows-msvc/release/bundle/nsis/`        |
| 应用可执行文件   | `target/x86_64-pc-windows-msvc/release/weblink-desktop.exe` |
| 内嵌前端构建产物 | `apps/desktop/dist/`                                        |

也可以直接使用构建环境变量提供默认值：

```powershell
$env:VITE_WEBSOCKET_URL = "wss://signal.example.com"
$env:VITE_SHARE_URL = "https://web.example.com"
bun run build:desktop --target x86_64-pc-windows-msvc --bundles nsis
```

只生成可执行文件、不生成安装包时：

```powershell
bun --env-file=apps/web/.env.desktop.local run build:desktop --target x86_64-pc-windows-msvc --no-bundle
```

可执行文件仍位于同一 release 目录，直接运行它的目标电脑需要已安装 WebView2。安装桌面端不会启动信令服务器，Server 或 Worker 需单独保持可用。

## 安装、启动与验证 {#verify}

1. 将生成的安装包复制到目标 Windows 电脑，完成安装后从开始菜单启动 Weblink。独立可执行文件可复制到本地目录后直接运行。
2. 在“设置 → 连接”检查信令地址。如果需要使用新安装包默认值，重置之前保存的地址。
3. 使用相同的后端和房间信息，从浏览器或另一台桌面端加入，检查消息、文件传输和断线重连。
4. 打开房间邀请链接或二维码，确认使用 `VITE_SHARE_URL` 指定的 Web 站点，并连接同一个后端。
5. 按需单独配置并授权[远程桌面](../guide/remote-control.md)或 [MCP 自动化](../guide/automation.md)。

关闭或最小化窗口后，应用可能继续在托盘运行；通过托盘菜单退出才能完全停止。更新自定义安装包时，使用自己的配置重新构建，退出旧应用后安装新包。内置版本检查指向官方 Weblink 下载，设置环境变量不会创建独立的更新服务。

## 接下来想了解什么？ {#troubleshooting}

- **已经安装，想了解文件、通知和更新操作**：继续阅读[桌面端使用指南](../guide/desktop.md)。
- **想为邀请链接准备自己的网页入口**：按 [Web 端部署](hosting.md)搭建对应站点。
- **安装后白屏或无法启动**：检查[桌面端运行环境](../guide/faq.md#desktop-start)。
- **能启动，但连不上自己的服务**：按 [WebSocket 连接排查](../guide/faq.md#signaling-unreachable)检查。
