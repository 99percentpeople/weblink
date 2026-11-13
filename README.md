<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="apps/web/public/branding/weblink-logo-dark.svg" />
    <img src="apps/web/public/branding/weblink-logo-light.svg" alt="Weblink" width="300" height="96" />
  </picture>

  <h3>Share more. Install less.</h3>

  <p>
    Chat, share files, make calls, and control your desktop with WebRTC.
    Use Weblink in your browser or with the Windows desktop app.
  </p>

  <p>
    <a href="https://webl.ink"><strong>Open Weblink</strong></a>
    ·
    <a href="https://docs.webl.ink/">Documentation</a>
    ·
    <a href="https://github.com/99percentpeople/weblink/releases/latest">Download desktop</a>
    ·
    <a href="README_CN.md">中文</a>
  </p>

  <p>
    <img src="https://img.shields.io/badge/WebRTC-P2P-5b5bd6" alt="WebRTC P2P" />
    <img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" />
  </p>
</div>

## What you can do

- **Chat across devices:** rooms, private conversations, attachments, and local history.
- **Share files:** resumable transfers, a local file library, and shared file lists.
- **Meet and record:** voice, video, screen sharing, and recording of a selected source.
- **Control a desktop:** use a phone or computer browser to operate an authorized Windows host.
- **Connect AI tools:** use MCP and supported browser WebMCP clients for authorized automation.
- **Self-host:** connect existing clients to your own signaling backend, with optional frontend hosting.

Devices exchange messages, files, and media over WebRTC, with TURN relaying when
needed. History, device identity, and permissions stay in the local client profile;
joining a room does not automatically grant remote control.

## Quick links

Detailed usage, configuration, and deployment instructions live in the
[documentation website][quick-start].

| What you need                                 | Documentation                                                           |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| Connect your first devices                    | [Quick start][quick-start]                                              |
| Install and use the desktop app               | [Desktop app][desktop]                                                  |
| Chat and send files                           | [Rooms and chat][rooms] · [File transfers][files]                       |
| Choose storage and manage files               | [File storage][storage]                                                 |
| Call, share a screen, or record               | [Audio, video, and recording][media]                                    |
| Control another computer                      | [Remote desktop][remote-control]                                        |
| Pair devices and manage access                | [Device pairing and permissions][device-trust]                          |
| Connect an MCP client                         | [MCP and automation][automation]                                        |
| Configure signaling, STUN/TURN, or test speed | [Connection settings][connection]                                       |
| Understand components and data flow           | [Architecture overview][architecture]                                   |
| Choose what to self-host                      | [Self-hosting overview][self-hosting]                                   |
| Deploy your clients                           | [Web deployment][web-deploy] · [Tauri deployment][tauri-deploy]         |
| Run your signaling backend                    | [Server deployment][server-deploy] · [Worker deployment][worker-deploy] |
| Resolve a problem                             | [Troubleshooting][faq]                                                  |

## Contribute and get help

Report problems or suggest improvements through [GitHub Issues](https://github.com/99percentpeople/weblink/issues).
For code contributions, see [Contributing](CONTRIBUTING.md). Version changes are
listed in the [changelog](CHANGELOG.md).

## License

Weblink is available under the [MIT License](LICENSE).
Third-party media notices: [Mediabunny](apps/web/public/licenses/mediabunny.txt)
and [NVENC interface](apps/web/public/licenses/nvcodec.txt).

[quick-start]: https://docs.webl.ink/
[desktop]: https://docs.webl.ink/guide/desktop.html
[rooms]: https://docs.webl.ink/guide/rooms.html
[files]: https://docs.webl.ink/guide/files.html
[storage]: https://docs.webl.ink/guide/storage.html
[media]: https://docs.webl.ink/guide/media.html
[remote-control]: https://docs.webl.ink/guide/remote-control.html
[device-trust]: https://docs.webl.ink/guide/device-trust.html
[automation]: https://docs.webl.ink/guide/automation.html
[connection]: https://docs.webl.ink/guide/connection.html
[architecture]: https://docs.webl.ink/architecture/overview.html
[self-hosting]: https://docs.webl.ink/deployment/overview.html
[web-deploy]: https://docs.webl.ink/deployment/hosting.html
[tauri-deploy]: https://docs.webl.ink/deployment/tauri.html
[server-deploy]: https://docs.webl.ink/deployment/backend.html
[worker-deploy]: https://docs.webl.ink/deployment/worker.html
[faq]: https://docs.webl.ink/guide/faq.html
