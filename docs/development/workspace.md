# 工作区开发

Weblink 主 Git 仓库维护应用、共享文档和根目录工具。两个信令服务器作为 Git 子模块管理。Web 应用位于 `apps/web`，`apps/desktop` 中的 Tauri 外壳复用同一套前端。

## 获取代码与依赖 {#checkout-and-dependencies}

```sh
git clone --recurse-submodules https://github.com/99percentpeople/weblink.git
cd weblink
bun install --frozen-lockfile
```

如果克隆时没有包含子模块，或者拉取了新的 gitlink，运行：

```sh
git submodule update --init --recursive
```

根工作区覆盖 `apps/*`、`packages/*` 和 `servers/*`，共用根目录 `bun.lock`，采用隔离的依赖布局。初始化子模块后，一次 `bun install` 即可安装前端和两个服务器的依赖。根包仅作为私有工具包；应用包名为 `@weblink/web`，版本号仍维护在 `apps/web/package.json`。隔离依赖可避免前端与 Worker 使用的不同 TypeScript/Vitest 版本互相干扰。

使用 Bun **1.4.2**，与 `packageManager`、CI 和前端 Docker 镜像一致。联合开发命令使用 Bun 内置的并行脚本运行器，该能力从 Bun 1.3.9 开始提供。根目录 override 也将服务器的 npm `bun` 依赖固定到这一版本，避免其较旧的独立运行时覆盖工作区命令。

PWA 插件与资源生成器使用相互兼容的 **2.x** 版本线，支持 Vite 6，要求 Node **20.19+**，CI 使用 Node 24。资源生成器通过 `sharp` 使用 npm 分发的原生二进制，安装时应启用可选依赖。根目录不需要额外覆盖 `sharp` 版本。

Git 子模块固定服务器源码版本，并保留独立发布工作流。工作区安装使用根 `bun.lock`；各服务器自己的锁文件供独立克隆使用。修改服务器依赖时，需要更新其独立锁文件，并在更新 gitlink 后刷新根锁文件。安装依赖本身不会更新子模块提交。

## 同时运行前端和本地信令 {#frontend-and-local-signaling-together}

完成根目录依赖安装与子模块初始化后：

```sh
cp .env.example .env
bun dev
```

`bun dev` 显式加载根 `.env`，其中配置 Vite 端口 `WEBLINK_WEB_PORT`、服务器端口和地址 `PORT`、`HOSTNAME`，以及本地信令 URL `WEBLINK_WEBSOCKET_URL`。示例 URL 会展开 `${PORT}`，随服务器端口一起变化。服务器专用配置和密钥仍保存在服务器自己的环境文件中；通过 `bun dev` 运行时，根目录配置优先。

`bun dev` 同时运行 Vite 与 Bun 服务器，并给输出加上服务标签。默认地址分别为 localhost:5173 和 127.0.0.1:9000。Ctrl+C 会停止两者；任一脚本出错退出也会停止另一项。Vite 在端口占用时直接报错，不会自动换端口。启动前应停止已有服务，或在 `.env` 中选用其他端口。

只启动一个服务时，使用 `bun run dev:web` 或 `bun run dev:server`。根目录 `WEBLINK_WEBSOCKET_URL` 仅在 Vite 开发服务运行期间覆盖前端信令地址；生产构建仍使用应用的 `VITE_*` / `WEBLINK_*` 配置。

## 前端命令 {#frontend-commands}

在仓库根目录运行：

```sh
bun run dev:web
bun run lint
bun run test:unit
bun run test:integration
bun run build
bun run build:dev
bun preview
```

所有现有的 `test:e2e:*` 与 `bench:browser:cache` 命令仍可在根目录执行。它们委托给 Web 工作区，保持相对于应用的资源和测试路径不变，也可直接运行应用命令：

```sh
bun run --cwd apps/web dev
```

将 `apps/web/.env.example` 复制为 `apps/web/.env.local`，用于本地应用配置。Vite 从 `apps/web` 读取环境文件；根 `.env` 保存前述联合开发配置。前端构建时的 `VITE_*` / `WEBLINK_*` 值应放入应用环境文件。生产和开发构建产物均写入 `apps/web/dist`。根目录 `bun run clean` 会清理工作区依赖，包括服务器依赖，以及前端输出，不会删除环境文件。

## 桌面端 {#desktop}

`bun run dev:desktop` 使用根 `.env` 启动 Tauri、其 Vite 服务和本地信令。`bun run build:desktop` 为当前主机平台创建原生构建。桌面端前置依赖、Windows 安装包命令与能力限制见[桌面端开发](desktop.md)。根 `Cargo.toml` 和 `Cargo.lock` 管理 Tauri 外壳及 `crates/` 下的原生 Rust crate；`bun install` 只管理 JavaScript 依赖。

## 源码同步 {#source-sync}

两台机器都需要安装 rsync 3.x，并配置 SSH 密钥访问。在根 `.env` 中设置目标，含空格的路径可加引号：

```dotenv
WEBLINK_SYNC_TARGET=user@host:/path/to/weblink
# Optional when rsync is not on the remote PATH:
# WEBLINK_SYNC_RSYNC=/usr/local/bin/rsync
```

```sh
bun run sync --dry-run
bun run sync
bun run sync:watch
```

目标可以是 Linux、macOS 或 Windows。Windows 使用官方 [cwRsync 便携包](https://itefix.net/cwrsync) 时，目标路径可写为 `yzzpc:/cygdrive/c/Users/name/Desktop/weblink`，并将 `WEBLINK_SYNC_RSYNC` 设为 `C:/Users/name/AppData/Local/Programs/cwrsync/bin/rsync.exe`。

监听器先执行一次同步，之后每秒检查 Git 可见的源码，合并保存操作，仅发送上次成功同步后发生变化的文件。只更新前端时，不会访问未变化的 Rust 文件，避免 Windows 文件写入通知误触发 Tauri 重启。Ctrl+C 可停止监听；传输失败后每三秒重试。同步包括未提交文件与已初始化的子模块源码。Git 元数据、`.env` 文件、`.tmp`、依赖和构建输出保留在各自机器上；环境文件只复制 `.env.example`。不接受源码符号链接。

同步是单向的。远端独有文件会保留；本地删除仅传播到以前已成功同步过的文件。远端被替换或删除的文件备份在目标的 `.tmp/rsync-backups/`。每个目标都有独立的本地同步清单和进程锁。同步不会安装依赖或重启命令，正在运行的开发监听器自行响应源码变化。

浏览器和桌面端的 Vite 服务按模式使用不同的依赖缓存。Vite 6 启动时读取工作区文本格式的 `bun.lock`，验证依赖缓存。依赖变化后，应在接收端运行 `bun install` 并重启开发命令；普通源码同步无需重启服务器。Vite 文件监听器会等待替换后的文件稳定。

`src/bootstrap.ts` 和普通 TypeScript 应用组合层负责上下文身份及服务生命周期。UI 组件在这一所有者之下刷新，因此视图更新会保留会议、本地采集和应用控制器。上下文定义或应用组合变化会通过 Vite 原生依赖处理传播到入口并重建页面。项目没有自定义上下文刷新或依赖缓存插件。

## 信令服务器 {#signaling-servers}

运行以下命令前，先初始化子模块并在根目录执行一次 `bun install`。

Bun 服务器：

```sh
cd servers/weblink-ws-server
bun run test
bun run build
bun run dev
```

Worker：

```sh
cd servers/weblink-ws-worker
bun run typegen
bun run typecheck
bun run format:check
bun run test
bunx wrangler deploy --dry-run
bun run dev
```

独立克隆服务器仓库时，在该仓库运行 `bun install --frozen-lockfile`，使用其自己的锁文件，并遵循各服务器的环境示例与部署说明。服务器密钥留在服务器环境中，不放入前端。安装工作区依赖后，根目录的 `dev:server`、`dev:worker`、`test:server`、`test:worker` 和 `build:server` 提供便捷入口。

根 `Signaling servers` 工作流递归检出固定提交，从根锁文件安装依赖后执行服务器检查，不发布任何服务器。发布仍由各自仓库的工作流负责。子模块中的工作流不会自动作为父仓库的工作流运行。

## 更新子模块 {#updating-a-submodule}

新克隆中的子模块通常处于 detached HEAD 状态。编辑前，在服务器仓库内创建或切换到合适的分支：

```sh
git -C servers/weblink-ws-server switch -c my-server-change
```

在服务器仓库测试并提交，然后推送分支或通过该仓库的正常流程合并。当选定提交已经可以从配置的远端获取后，刷新工作区锁文件，并与父仓库指针一起提交：

```sh
bun install
git add servers/weblink-ws-server bun.lock
git commit -m "chore: update Bun signaling server"
```

Worker 在 `servers/weblink-ws-worker` 下采用相同流程。`git submodule update --init --recursive` 恢复父仓库固定的版本；`--remote` 会选择上游新提交，属于主动依赖更新，不是普通安装步骤。切换固定版本前应先检查服务器的本地修改。

## 构建与部署 {#building-and-releasing}

自行部署时，按 [Web 端部署](../zh/deployment/hosting.md)配置 `apps/web/.env.local`，运行根目录的 `bun run build`，再托管 `apps/web/dist`。Bun 服务和 Cloudflare Worker 的配置、启动及连接验证分别见 [Server 部署](../zh/deployment/backend.md)与 [Worker 部署](../zh/deployment/worker.md)。

构建前端 Docker 镜像或运行 Compose 前，先初始化子模块。前端镜像读取所有工作区清单，只安装根工具和前端依赖。Compose 以固定版本的本地 Bun 服务器子模块作为服务器构建上下文，使用该服务器的独立锁文件。
