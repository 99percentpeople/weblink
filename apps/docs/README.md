# Weblink Docs

面向 Weblink 用户的中英文 VitePress 文档站，正式地址为 [docs.webl.ink](https://docs.webl.ink/)。英文为默认语言，位于 `/`；中文位于 `/zh/`。两种语言都直接打开快速开始，正文聚焦功能使用、设计架构、配置、常见问题和自部署。

在仓库根目录安装依赖后运行：

```sh
bun run dev:docs
bun run check:docs
bun run build:docs
bun run preview:docs
```

开发地址 `http://127.0.0.1:5175`，预览地址 `http://127.0.0.1:4175`，构建产物 `apps/docs/dist`。

部署时运行 `bun run build:docs` 并托管 `apps/docs/dist`。通过构建环境变量 `DOCS_BASE` 配置路径，默认 `/` 适用于正式域名；如部署在子路径，可设置为 `/docs/`，必须以 `/` 开头和结尾。

## 自动部署

`.github/workflows/docs.yml` 将文档站独立部署到 Cloudflare Pages 项目 `weblink-docs`，
生产分支为 `public`，域名为 [docs.webl.ink](https://docs.webl.ink/)。
推送公开文档、文档站配置与资源、共享主题、根依赖配置或相关部署脚本时触发；
PR 只检查和构建，推送到 `public` 才发布。无需修改应用版本、创建 tag 或发布 GitHub Release。
仅修改宣传站、应用代码、仓库内部开发参考或本站 README 不触发文档站流程。

发布前，工作流比较构建文件的内容摘要与 `weblink-docs.pages.dev` 上的 `deployment.json`。
内容相同会跳过部署，包括手动重跑和未改变输出的依赖配置更新。
摘要包含文件路径与内容，新增、修改、删除文件都会参与比较；来源提交和文件时间不参与比较。
部署记录只用于去重和发布校验，不是需要人工维护的版本号。
构建读取完整 Git 历史，使文章的“最后更新”日期对应实际修改；本地搜索按固定顺序生成，避免相同内容因索引顺序变化产生不同摘要。正式部署按顺序执行。

首次配置：

1. 按 [Direct Upload 创建说明](https://developers.cloudflare.com/pages/get-started/direct-upload/#create-your-project)，
   使用 `wrangler pages project create` 创建项目 `weblink-docs`，在提示中将生产分支设为 `public`。
   由 GitHub Actions 上传，不另启用 Cloudflare Git 自动部署。
   如果分配的 Pages 域名带随机后缀，在仓库 Variables 中将 `DOCS_PAGES_URL` 设为实际 HTTPS 根地址，
   供发布前比较和发布后校验使用。
2. 在 GitHub 仓库或 `production` 环境的 Actions Secrets 中配置
   `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`；可与宣传站共用同一账户的 Pages 编辑凭据。
   具体权限与配置见 [Cloudflare CI 部署说明](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)。
3. `docs.webl.ink` 使用根路径，保留 `DOCS_BASE=/` 即可。需要其他路径时，
   在仓库 Actions Variables 设置 `DOCS_BASE` 并匹配托管路径；这是构建配置，不是运行时变量。
4. 在 Actions 的 **Documentation production** 中对 `public` 运行工作流。
   也可省去第 1 步的本地创建，勾选 `create_project`，让工作流使用已有凭据创建项目并完成首次发布；仅在项目尚不存在时使用一次。
   首次发布若 Pages 域名尚不可访问，勾选 `force` 跳过发布前检查；后续保持默认即可。
5. 在 Pages 项目的自定义域名中绑定 `docs.webl.ink`，按提示配置 DNS，等证书生效后访问英文根路径与 `/zh/`。
   绑定步骤见 [Cloudflare 自定义域名说明](https://developers.cloudflare.com/pages/configuration/custom-domains/)。
   也可手动运行 **Pages domain setup** 工作流并选择 `docs`：它绑定域名，并仅在 DNS 记录缺失时创建 CNAME。
   这一步需要 Token 同时具有该域名的 DNS 编辑权限；权限不足时在控制台完成即可，不影响后续仅需 Pages 编辑权限的站点发布。
   已存在且指向不同目标的 DNS 记录会要求人工处理，不会自动覆盖。

正常情况下，有修改就推送到 `public`，工作流会自行判断并发布对应站点。
只改 GitHub Variables 时手动运行对应工作流，无需修改源码来触发。
网络检查失败会停止发布；首次初始化或明确需要重新发布相同内容时才使用 `force`。
发布后校验 Pages 域名上的内容摘要，自定义域名的 DNS 与证书由首次配置保证。

## 内容边界

- 公开英文内容：`docs/index.md`、`docs/guide`、`docs/architecture`、`docs/deployment`。对应中文位于 `docs/zh`，使用相同相对路径。
- 设计架构放在使用与部署之间。概览说明组件与部署边界，专题说明信令恢复、P2P 控制协议、文件分块与续传、媒体与录制、浏览器及原生编解码与 GPU 显示、音频采集与播放、设备身份、存储生命周期；结合实际报文和实现入口解释长期稳定的机制与限制。
- 仓库内部资料继续保留原来的目录：中文在 `docs/development`、`docs/reference`，英文在 `docs/en/development`、`docs/en/reference`。这些完整参考及目录归属、测试、贡献、CI、发布和补丁维护说明不参与站点构建或搜索；适合公开阅读的协议与实现说明整理到 `architecture`，与中英文指南衔接。
- `docs/README.md` 是仓库文档索引。顶层大写文件是历史入口，也不参与构建。
- 宣传站和文档站自身的开发维护说明放在各自 README 中。

## 内容维护

- 使用指南从用户任务出发，写清入口、操作步骤、配置生效方式和限制；架构专题说明协议、数据流、状态与平台边界，不混入项目维护流程。仓库内部资料不应仅通过隐藏导航保留在公开构建里。
- 常见问题与故障排查统一维护在 `guide/faq.md` 及其中文版本，按主题合并重复问题。需要尾部导读时，只放相关操作指南和 FAQ 章节入口；配置前提及正常验证步骤保留在正文。
- FAQ 只收录实际故障、已知兼容性限制及对应处理方式，不把正常功能、权限或配置说明改写成问答凑数。浏览器与编码支持需区分发送、接收和播放，注明适用条件与资料来源；地区网络问题按实际端点和网络排查，不写未经验证的全地区结论。
- 导读从读者接下来想完成的任务或想解决的问题出发，先说明选择场景，再提供具体章节链接。每篇按上下文选择相关去向，不直接罗列文档标题。已有按任务或主题选择的列表、表格时，不再追加“接下来想了解什么？”尾节；独有去向合并到现有导读或相关正文，中英文同步调整。
- 公开页面与导航统一在 `.vitepress/catalog.ts` 的 `pages` 定义，构建排除规则在同文件的 `sourceExcludes`；分组和导航文案在 `.vitepress/navigation.ts`。
- 中英文保持相同路由、显式章节锚点和代码示例。参数、权限和失败行为必须与当前实现一致。
- 站内链接只指向公开的同语言页面。仓库维护资料通过仓库索引供贡献者阅读，不作为用户完成操作的必读步骤。
- 新增页面时同时加入两种语言和目录。`check:docs` 检查发布范围、翻译、导航及站内链接，不应把内部页面加入目录来绕过校验。
- 主题适配在 `.vitepress/theme`，`public` 保存图标、透明 Logo 和文档插图。不要提交缓存、构建产物、本地环境配置和临时验证日志。
- 协议流程图保存在 `public/diagrams`，按 `主题-en.svg`、`主题-zh.svg` 配对。SVG 内保留标题、描述和深浅配色，通过宿主的 `color-scheme` 跟随站点主题；正文使用 `docs-diagram` 图注与可键盘滚动的 `docs-diagram-scroll` 容器，避免窄屏下将文字缩得过小。

完整索引见[仓库文档](../../docs/README.md)。
