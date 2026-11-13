<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/branding/weblink-logo-dark.svg" />
    <img src="apps/web/public/branding/weblink-logo-light.svg" alt="Weblink" width="300" height="96" />
  </picture>

  <h3>分享更多，安装更少。</h3>

  <p>
    通过 WebRTC 聊天、分享文件、音视频通话和控制远程桌面。
    可直接在浏览器中使用，也可运行 Windows 桌面端。
  </p>

  <p>
    <a href="https://webl.ink"><strong>打开 Weblink</strong></a>
    ·
    <a href="https://docs.webl.ink/zh/">使用文档</a>
    ·
    <a href="https://github.com/99percentpeople/weblink/releases/latest">下载桌面端</a>
    ·
    <a href="README.md">English</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/WebRTC-P2P-5b5bd6" alt="WebRTC P2P" />
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  </p>
</div>

## 主要功能

- **跨设备聊天**：房间交流、私聊、附件和本地历史记录。
- **文件共享**：可恢复的文件传输、本地文件库和共享文件列表。
- **音视频协作**：语音、视频、屏幕共享，以及对选定来源进行录制。
- **远程桌面**：从手机或电脑浏览器操作已授权的 Windows 主机。
- **AI 自动化**：通过 MCP 或支持 WebMCP 的浏览器客户端执行已授权操作。
- **自行部署**：用现有客户端连接自己的信令后端，也可自行托管前端。

设备通过 WebRTC 传输消息、文件和媒体，需要时使用 TURN 中继。聊天历史、设备身份和权限保存在本机配置中，加入房间不会自动获得远程控制权。

## 快速入口

详细的使用、配置和部署说明统一维护在[文档站][quick-start]。

| 你想做什么                 | 文档入口                                                    |
| -------------------------- | ----------------------------------------------------------- |
| 第一次连接设备             | [快速开始][quick-start]                                     |
| 安装和使用桌面端           | [桌面端使用][desktop]                                       |
| 聊天和发送文件             | [房间与聊天][rooms] · [文件传输][files]                     |
| 选择存储位置、管理文件     | [文件存储与管理][storage]                                   |
| 通话、共享屏幕或录制       | [音视频与录制][media]                                       |
| 控制另一台电脑             | [远程桌面][remote-control]                                  |
| 配对设备、调整权限         | [设备配对与权限][device-trust]                              |
| 接入 MCP 客户端            | [MCP 与自动化][automation]                                  |
| 配置信令、STUN/TURN 或测速 | [连接设置与测速][connection]                                |
| 了解组件分工与数据流       | [架构概览][architecture]                                    |
| 选择需要自部署的部分       | [自部署导读][self-hosting]                                  |
| 部署客户端                 | [Web 端部署][web-deploy] · [Tauri 端部署][tauri-deploy]     |
| 部署信令后端               | [Server 部署][server-deploy] · [Worker 部署][worker-deploy] |
| 排查使用问题               | [常见问题][faq]                                             |

## 参与贡献与反馈

问题与建议可提交到 [GitHub Issues](https://github.com/99percentpeople/weblink/issues)。代码贡献请阅读[贡献指南](CONTRIBUTING.md)，版本变化见[更新日志](CHANGELOG.md)。

也可以加入 QQ 群反馈：[762463759](https://qm.qq.com/cgi-bin/qm/qr?_wv=1027&k=5MRpXPQN4vGtiLnTzCUb-NlAK9txeEoE&authKey=Gm3OmhI6g3ccmNx8rXVcPsbmEzsoBcj%2FpF%2FOlq7edcbMxTlhPLipZ6i9fwsPCsLt&noverify=0&group_code=762463759)。

## 开源许可

Weblink 基于 [MIT License](LICENSE) 开源。
媒体依赖声明：[Mediabunny](apps/web/public/licenses/mediabunny.txt) 和 [NVENC 接口](apps/web/public/licenses/nvcodec.txt)。

[quick-start]: https://docs.webl.ink/zh/
[desktop]: https://docs.webl.ink/zh/guide/desktop.html
[rooms]: https://docs.webl.ink/zh/guide/rooms.html
[files]: https://docs.webl.ink/zh/guide/files.html
[storage]: https://docs.webl.ink/zh/guide/storage.html
[media]: https://docs.webl.ink/zh/guide/media.html
[remote-control]: https://docs.webl.ink/zh/guide/remote-control.html
[device-trust]: https://docs.webl.ink/zh/guide/device-trust.html
[automation]: https://docs.webl.ink/zh/guide/automation.html
[connection]: https://docs.webl.ink/zh/guide/connection.html
[architecture]: https://docs.webl.ink/zh/architecture/overview.html
[self-hosting]: https://docs.webl.ink/zh/deployment/overview.html
[web-deploy]: https://docs.webl.ink/zh/deployment/hosting.html
[tauri-deploy]: https://docs.webl.ink/zh/deployment/tauri.html
[server-deploy]: https://docs.webl.ink/zh/deployment/backend.html
[worker-deploy]: https://docs.webl.ink/zh/deployment/worker.html
[faq]: https://docs.webl.ink/zh/guide/faq.html
