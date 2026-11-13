# Architecture overview

Weblink keeps interaction, media processing, and local data on the participating devices. A signaling service helps them find each other and negotiate connections; WebRTC carries their content directly or through a TURN relay. These responsibilities explain both the client experience and which services you need to deploy.

## Components and responsibilities {#components}

![Two clients use WebSocket signaling to negotiate a WebRTC connection. Content travels directly or through TURN; STUN helps discover network addresses.](/architecture-en.svg)

The diagram separates connection setup from content transfer. The direct and TURN paths are alternatives for a connection, not two required copies of the same traffic.

| Component                  | Responsibility                                                                                        | What this means for users                                                                    |
| -------------------------- | ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Web client                 | Loads the interface in a browser and runs chat, transfers, capture, playback, and permission handling | Available features depend on browser APIs, permissions, and codecs                           |
| Tauri desktop client       | Reuses the frontend and adds native Windows capabilities through a platform adapter                   | Provides native capture, incoming remote input, system file access, and an HTTP MCP endpoint |
| Signaling Server or Worker | Maintains room presence and forwards connection negotiation                                           | All devices in a room use the same endpoint; signaling does not relay chat, files, or media  |
| STUN                       | Helps a device discover its public-facing network address                                             | Assists direct connectivity without carrying the shared content                              |
| TURN                       | Relays WebRTC traffic when direct connectivity is unavailable or relay-only mode is selected          | Relay reachability and bandwidth affect transfers and calls                                  |
| Client storage             | Holds local history, identity, permissions, files, and recordings in their respective stores          | Changing a backend does not move or synchronize this data                                    |

The Bun Server and Cloudflare Worker with Durable Objects provide alternative signaling implementations. Choosing one changes where signaling runs, while existing clients continue to connect through a WebSocket URL.

## From joining a room to exchanging content {#connection-flow}

1. **Load the client.** A browser downloads the web interface; the desktop app already contains its frontend. Loading the page does not establish a room connection.
2. **Join signaling.** The client connects to its configured WS/WSS endpoint and joins a room. Room IDs are scoped to that service, so matching IDs on different servers do not connect devices.
3. **Negotiate a peer connection.** Devices exchange connection descriptions and network candidates through signaling. WebRTC checks available paths, including STUN-discovered addresses and TURN relays when configured.
4. **Verify identity and permissions.** Devices establish pairing and apply their saved access policies before allowing protected operations. Room membership alone does not authorize remote control or automation.
5. **Exchange content.** Messages and file data use WebRTC data channels; microphone, camera, and screen video use media connections. Different content can have separate channels or connections, so a working chat does not prove that video capture or decoding will work.

Devices in a room establish peer connections with other participants. Room chat sends content to current online members, and sharing with multiple recipients uses the sender's resources and outgoing bandwidth. The signaling backend does not mix conference video or act as a central file distribution server.

## Signaling and content use different paths {#data-paths}

WSS carries room presence and connection negotiation. Once peer connections are established, application content uses WebRTC: a direct path when available, or a TURN relay when needed. TURN relays traffic; it does not become a chat-history service or file library.

The signaling service can still observe connection metadata such as room membership, client IDs, and negotiation timing. The separation of content and signaling does not mean that running a backend reveals no metadata.

This distinction also explains the checks in the [connection FAQ](../guide/faq.md#connection): a successful HTTP health check, a connected WebSocket, and a working device-to-device transfer verify different stages. Signaling reachability matters when joining or negotiating; content throughput also depends on the peer or relay path and the devices themselves.

## Shared frontend, different platform capabilities {#client-design}

The Web and Tauri clients share the SolidJS interface and application workflows. Platform adapters supply the actual browser or desktop capabilities, keeping a consistent room, conversation, transfer, and permission model across clients.

In the browser, capture, directory access, decoding, and other features depend on the APIs that browser exposes. The Windows desktop adapter adds native capture, encoding/decoding, input, file operations, and OS automation. The controlled computer therefore needs the desktop app, while a browser can act as its remote controller.

Clients exchange capabilities rather than assuming that every device supports the same operations or codecs. Automatic media encoding considers the sender's encoders and the connected receivers' decoders. Native desktop media has its own capabilities; support in a browser's player does not establish support on its WebRTC path. See [media settings](../guide/media.md#quality) and the [codec compatibility FAQ](../guide/faq.md#hevc-browsers).

## Local data and permission boundaries {#data-and-permissions}

| Data or access decision                                        | Where it belongs                                | Consequence                                                                                              |
| -------------------------------------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| Chat history, device identity, pairing, and permission records | The current browser or desktop profile          | They do not automatically follow you to another browser or computer                                      |
| Received files and recordings                                  | Browser storage or the selected local directory | Selecting a directory does not move identity or settings into it; changing the default affects new files |
| Room membership                                                | The selected signaling service                  | It coordinates online devices, without providing offline chat delivery or history recovery               |
| Remote control and automation approval                         | The destination device                          | A room password, invitation, or matching device name does not grant control                              |

Files in a local directory remain real files. Browser-stored files depend on the current site's storage; clearing site data can also remove history and identity records. Use [storage management](../guide/storage.md) for saving and cleanup, and [device permissions](../guide/device-trust.md) for pairing and authorization.

For MCP, the desktop HTTP endpoint authenticates a local MCP client with a token. Remote operations then travel through the existing device connection, and the destination checks its own permissions. It does not need a separate exposed HTTP MCP listener. Browser WebMCP is a separate local integration and does not provide native OS operations. See [MCP and automation](../guide/automation.md).

## How this architecture affects deployment {#deployment-boundaries}

Frontend hosting, signaling, and relaying can be managed independently:

- **Use your own signaling service:** deploy Server or Worker, then [change the WS URL](../guide/connection.md#signaling) in the existing website or desktop app. A frontend build is not required.
- **Manage the browser entry point too:** host the Web frontend on your own domain and choose its connection defaults.
- **Support networks that need relaying:** use a reachable TURN service, whether managed or self-hosted. Deploying signaling alone does not add a relay.
- **Preset desktop defaults:** build a Tauri package when needed; existing packages can already change their signaling address in settings.

The [self-hosting overview](../deployment/overview.md) turns these choices into deployment paths. Whichever components you host, the participating clients still perform capture, encoding, decoding, and file storage; more signaling-server capacity does not remove those device limits.

## Protocols and implementation {#read-further}

The following articles follow the actual wire formats and implementation boundaries. Choose the part of the system you want to understand in more detail:

| What you want to understand                                                    | Continue with                                         |
| ------------------------------------------------------------------------------ | ----------------------------------------------------- |
| How joining, offer collisions, and reconnects preserve the right connection    | [Signaling and session recovery](signaling.md)        |
| What messages, ACKs, retries, and capability announcements mean                | [P2P control protocol](p2p-protocol.md)               |
| How file bytes become blocks, missing ranges, and verified content             | [File transfer and resume](file-transfer.md)          |
| How capture, codecs, native rendering, and recording fit together              | [Media transport and recording](media.md)             |
| How browser and native codecs, GPU presentation, and quality settings interact | [Encoding, decoding, and GPU presentation](codecs.md) |
| How microphone/system capture, audio codecs, PCM bridges, and playback connect | [Audio capture, codecs, and playback](audio.md)       |
| How fresh identity proofs, pairing recovery, and permissions interact          | [Device identity and authorization](device-trust.md)  |
| How partial files, checkpoints, content references, and deletion work          | [Storage and file lifecycle](storage.md)              |

Each article includes implementation entry points for readers who want to follow the code. Usage and configuration steps remain in the corresponding guides.
