# Weblink www

Weblink 的独立多语言宣传站。使用 Vite、TypeScript 和静态 HTML，
不依赖 `apps/web` 的运行时，也不需要信令服务。
中文正文直接包含在 HTML 中；JavaScript 增强语言与主题切换、场景轮播和移动端导航。
语言与主题菜单通过 SolidJS 挂载与主应用一致的 Kobalte 无样式组件，
菜单定位、键盘导航、外部点击关闭和焦点恢复由组件库处理。
字体与品牌资源随站点一起构建，不依赖外部字体服务。
配色、字体和基础圆角由 `@weblink/theme` 提供，与主应用共用
`packages/theme/tokens.css`；在共享文件中调整主题，不在宣传站另建一套色板。

## 开发与构建

在仓库根目录安装工作区依赖后运行：

```sh
bun run dev:www
bun run lint:www
bun run build:www
bun run preview:www
```

开发地址为 `http://localhost:5174`，构建预览为 `http://localhost:4174`。
端口被占用时会直接报错；可通过命令行参数 `--port` 指定其他端口。
也可以直接在 `apps/www` 中运行对应的 `dev`、`lint`、`build`、`preview` 脚本。

文档站地址通过 `VITE_DOCS_URL` 配置，指向文档根目录，不包含语言路径。
本地开发默认使用 `http://localhost:5175/`，生产构建默认使用 `https://docs.webl.ink/`。
可将 `apps/www/.env.example` 复制为 `apps/www/.env.development.local`，设置本地地址：

```dotenv
VITE_DOCS_URL=http://localhost:5175
```

本地预览文档时，在另一个终端运行 `bun run dev:docs`。
部署时通过构建环境注入 `VITE_DOCS_URL`，也可在 `apps/www/.env.production.local` 中配置。
例如 `https://example.com/docs/` 会保留 `/docs/` 前缀，再追加语言和文章路径；末尾斜线会自动补齐。
地址同时应用于 HTML 链接与语言切换。修改本地环境文件后重启开发服务，修改部署地址后重新构建。
本地环境文件不提交到 Git。

## 内容与资源

- `index.html`：宣传文案、实际截图、版本入口、FAQ 和搜索/分享元信息。
- `src/styles.css`：页面布局、响应式样式和减少动态效果的偏好支持。
- `src/showcase.css`：笔记本与手机设备轮廓、截图切换和原图入口。
- `src/main.ts`：键盘可访问的场景轮播、导航菜单与监听器清理。
- `src/theme.ts`：通过根元素的 `dark` class 切换配色、品牌标识、截图和原图链接。
- `src/i18n.ts`、`src/locales/`：语言偏好、页面文案、元信息与辅助阅读文字。
- `src/dropdown.tsx`：基于 Kobalte DropdownMenu 的语言与主题菜单封装。
- `src/looping-track.ts`：轮播首尾衔接、过渡结束复位与临时节点清理。
- `public/`：从 Weblink 品牌资源复制的标识与站点 SVG 图标。
- `public/screenshots/`：主应用的实际运行截图，作为宣传素材随站点构建。
- `public/screenshots/dark/`：对应六个场景的实际深色界面截图。

主按钮打开 `https://webl.ink`；源码指向官方 GitHub 仓库，使用、媒体架构和自部署说明指向 `VITE_DOCS_URL` 指定的文档站。
文档链接通过 `data-docs-path` 保存相对路径，随宣传站语言切换：简体、繁体中文使用 `/zh/`，其余语言使用英文根路径 `/`。
无 JavaScript 时，中文 HTML 中的文档入口直接使用 `/zh/`；部署入口指向自部署导读，说明可以只部署信令服务并修改客户端 WS 地址。
首页和 Windows 卡片各保留一个「下载 Windows 版」按钮，统一跳转到
`https://github.com/99percentpeople/weblink/releases/latest`。
用户在发布说明中选择安装包或免安装 ZIP。宣传页入口不包含版本号，
也不需要在浏览器请求 GitHub API。更换仓库时，同步更新 `index.html`
中的两个发布页链接。

`desktop-production.yml` 一次编译生成主程序和 NSIS 安装包，同时保存：

| Actions artifact                | 发布到 GitHub Release 的附件       |
| ------------------------------- | ---------------------------------- |
| `weblink-windows-x64-installer` | `Weblink-windows-x64-setup.exe`    |
| `weblink-windows-x64-portable`  | `Weblink-windows-x64-portable.zip` |

免安装 ZIP 内包含 `weblink-desktop.exe` 和 `weblink-portable` 标记，保留两者并解压后运行，电脑需预先安装
WebView2 120 或更新版本；安装包会在需要时下载并安装 WebView2。
发布 GitHub Release 时，解压 Actions 下载的外层 artifact 压缩包，将上述
安装包 `.exe`、签名 `.exe.sig`、免安装 `.zip` 和 `latest.json` 按原名上传到同一个对应版本的 Release，
并将该正式版设为 Latest。

同一次构建会运行 `scripts/generate-release-notes.mjs`，生成包含英文
下载表格和当前版本 CHANGELOG 的 `release-notes.md`，保存在
`weblink-release-notes` artifact 中。创建 Release 时，将该文件内容用作
发布说明；两种下载链接均绑定本次 tag，保留历史版本与对应附件的关系。
更改附件名时，同步更新桌面生产构建流程和生成脚本。
工作流只构建并保存 artifact，GitHub Release 由发布者创建。

同一页面支持明暗主题：首次访问跟随系统，手动切换后以 `www-theme`
保存选择，刷新后沿用。电脑与手机端均在顶部提供主题下拉菜单，支持
「跟随系统、浅色模式、深色模式」；选择跟随系统后自动响应系统主题变化。
手机端的「打开 Weblink」按钮位于导航菜单中。
切换时同步更新轮播副本和原图链接；截图来自对应主题的实际应用界面，
不使用反色滤镜。无 JavaScript 时仍可浏览浅色页面与首个演示场景。

语言与主应用一致：简体中文、繁体中文、英语、日语、韩语、西班牙语、
法语和德语。语言列表与匹配规则共用 `@weblink/locale`，位于
`packages/locale`；站点文案独立维护在 `src/locales/`。
顶部语言菜单在电脑与手机端均直接可用。默认按浏览器语言列表选择，
没有匹配时使用英语；「跟随系统」会响应浏览器的 `languagechange`。
手动选择以 `www-locale` 保存，刷新后沿用，与主应用的偏好存储独立。
切换时更新 `html.lang`、标题、描述、截图说明和辅助阅读文字，保留当前
轮播位置、主题与展开的 FAQ。所有语言统一使用英文演示截图，不随语言重绘。
新增主应用语言时，需要同步补齐站点字典；类型检查会检测缺失的语言和键。

展示区按「远程桌面 → 视频会议 → 聊天 → 共享文件」每 6 秒横向无缝轮播，末尾继续
向前滑到第一张，不倒退穿过中间场景。点击标签和左右方向键、Home、End
手动切换时按页面顺序直接滑动，例如从最后一页返回第一页时向回滑，
只有自动播放使用无缝循环。选中标签的气泡背景同步滑动。
鼠标悬停在展示区时自动暂停；
键盘焦点位于标签或截图、页面进入后台时也暂缓轮播，
恢复后重新计时。系统开启减少动态效果时默认不自动播放。

## 更新产品截图

截图来自本地运行的 `apps/web`。独立浏览器会话通过信令服务加入
同一演示房间，实际发送消息、共享浏览器标签页并传输文件。
应用布局和展开的画面操作栏来自实际 UI；设备外框用 CSS 绘制。
手机图片来自移动视口截图，不代表手机硬件测试。
手机截图还需模拟移动浏览器的 UA 与触摸能力，并在应用加载前移除
`navigator.mediaDevices.getDisplayMedia` 和 `window.documentPictureInPicture`。
仅缩小桌面浏览器视口仍会保留桌面 API，导致截图多出屏幕共享等按钮。
让应用按能力检测自然渲染，截取前确认没有屏幕共享按钮、底部工具栏没有横向溢出；
不要通过隐藏按钮或修改图片来修补截图。

- `remote-desktop.webp`：电脑端 Windows 桌面演示，显示正在控制状态与操作栏。
- `mobile-remote.webp`：手机查看同一 Windows 演示桌面，顶部显示控制中。
- `video-meeting.webp`：电脑端四人视频会议，使用主应用实际的网格布局和工具栏。
- `mobile-meeting.webp`：手机端同一场四人视频会议，按移动浏览器能力显示操作按钮。
- `screen-chat.webp`：电脑接收端查看 Windows 演示画面，展开操作栏与聊天。
- `mobile-screen.webp`：手机视口中的同一房间聊天。
- `shared-files.webp`：电脑视口中展开共享文件面板。
- `mobile-files.webp`：手机视口中查看同一成员共享的示例文件。

Windows 画面是微软公开的演示素材，通过浏览器标签页共享：
[Windows 11 发布文章](https://blogs.windows.com/windowsexperience/2021/10/04/windows-11-a-new-era-for-the-pc-begins-today/)
中的 [Start 图片](https://winblogs.thesourcemediaassets.com/sites/2/2021/10/Start.jpg)。
画面版权归 Microsoft；这是桌面外观示例，不是一次 Windows 远程控制实机记录。
远程桌面场景中的控制状态由主应用的实际 UI 渲染：隔离的演示接收端使用
实际 `RemotePointer` 与配对的 RTCDataChannel，演示主机响应授权、激活
和心跳消息，不连接操作系统输入。页面亦注明桌面与控制会话为演示，
这些截图不作为 Windows 原生控制能力的实机验证。
不得截取或加入用户的个人桌面、文件或聊天资料。

视频会议使用四位虚构人物，原始人物图和生成提示词保存在
`assets/conference/`（`alex.png`、`maya.png`、`sofia.png`、`noah.png` 与
`prompts.json`），由内置 imagegen 工具生成。这些源素材不随静态站点发布。
截图时将人物图作为隔离会话中的演示摄像头画面，通过 Canvas MediaStream
接入主应用实际的摄像头开关与 WebRTC 链路，再截取四人会议界面。
不访问真实摄像头、麦克风或桌面；会议人物为 AI 生成的说明在页面上可见。
人物素材是静态演示画面，不代表真实视频通话或性能测试。

刷新素材时使用当前应用和仅包含虚构内容的演示房间，将应用语言设为
`en-us`，设备名称、房间名、聊天内容和示例文件名也统一使用英文。
分别在浅色、深色主题下截取同名素材；深色版本放在 `public/screenshots/dark/`。
电脑视口为 1440 × 900，手机视口为 390 × 844，均按 1.5 倍像素密度
直接截取 WebP；图片尺寸分别为 2160 × 1350 和 585 × 1266。
保留完整的应用界面，若尺寸变化，同时更新 `index.html` 的宽高属性。
设备外框保持等高，手机画面延伸至窄底边；改变截图比例时，
同步调整 `src/showcase.css` 中的列宽比例。
文件名保持稳定，页面的原图链接也会一并更新。

## 静态部署

将 `apps/www/dist` 的全部内容部署到静态托管服务即可；
不需要服务端运行时或 SPA 路由回退。构建使用相对资源路径，
可托管在域名根目录或带末尾斜杠的子目录（例如 `/www/`）。

托管服务若从仓库根目录执行构建，可使用 `bun run build:www`，
输出目录设置为 `apps/www/dist`。本项目独立于现有 Web 应用的部署流程。

正式站点为 [www.webl.ink](https://www.webl.ink/)，对应独立的 Cloudflare Pages 项目
`weblink-www`，生产分支为 `public`。`www-production.yml` 处理宣传站，
`docs.yml` 处理[文档站](../docs/README.md)，两者都不依赖应用版本、tag 或 GitHub Release。

宣传站源码、共享主题与语言包、根依赖配置或相关部署脚本变化时，PR 只检查和构建；
推送到 `public` 后，工作流比较构建内容与 `weblink-www.pages.dev` 上的内容摘要。
相同则跳过上传，变化才部署；仅修改应用、文档正文或本 README 不触发宣传站流程。
根锁文件变化可能触发构建，但输出内容未变仍不会重复部署。

`deployment.json` 保存文件内容摘要及来源提交，用于判断变化和确认发布成功，
不包含应用版本号。文件时间与来源提交不参与摘要，重复运行相同内容会跳过部署。
正式部署按顺序执行，避免旧构建覆盖新构建；PR 检查可以取消过时运行。

首次配置：

1. 在 Cloudflare Pages 使用 `weblink-www` 项目，生产分支设为 `public`。
   使用 GitHub Actions 上传产物；若项目还启用了 Cloudflare Git 自动构建，关闭该自动部署，避免发布两次。
   如果项目实际的 Pages 域名不是 `weblink-www.pages.dev`，在仓库 Variables 中设置 `WWW_PAGES_URL` 为该 HTTPS 根地址。
2. 在 GitHub 仓库或 `production` 环境的 Actions Secrets 中配置
   `CLOUDFLARE_API_TOKEN` 和 `CLOUDFLARE_ACCOUNT_ID`。
   Token 需要目标账户的 Cloudflare Pages 编辑权限，配置方法见
   [Cloudflare CI 部署说明](https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/)。
3. 可在仓库 Actions Variables 中配置 `VITE_DOCS_URL`，默认 `https://docs.webl.ink`。
   它在构建阶段生效；修改变量后，在 Actions 的 **Marketing production** 中对 `public` 运行工作流。
4. 在 Pages 项目的自定义域名中绑定 `www.webl.ink`，按 Cloudflare 提示完成 DNS 与证书配置。
   应用入口 `webl.ink` 继续使用原有的 `weblink` 项目。

第一次发布时，如果 Pages 域名尚不可访问，在 **Run workflow** 中勾选 `force`。
日常自动部署和手动运行默认都检查内容是否变化；只有首次初始化或明确需要重新发布时才使用 `force`。
网络检查失败会停止部署，不会将不可达误判为内容变化；发布后会校验 Pages 域名上的内容摘要。
自定义域名的 DNS 与证书只需首次配置，常规更新只发布站点文件。
