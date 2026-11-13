# Self-hosting overview

**You can deploy only a signaling backend and keep using the existing Weblink website or desktop app.** Change the WebSocket URL in each client to connect to your service; hosting a frontend or building a desktop package is optional.

To understand the component responsibilities and where content travels, start with the [architecture overview](../architecture/overview.md). This page helps you choose which parts to run yourself.

## Choose what to deploy {#choose-scope}

| Your goal                                                               | What you need                                                                                   |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Use your own room and signaling service                                 | One [Server](backend.md) or [Worker](worker.md), plus existing Weblink clients                  |
| Improve connectivity across networks that prevent direct connections    | Reachable STUN/TURN services; see the [options below](#stun-and-turn)                           |
| Serve the web interface on your own domain or embed connection defaults | [Web deployment](hosting.md), connected to your chosen signaling backend                        |
| Embed your service addresses in a desktop package                       | [Tauri deployment](tauri.md); existing packages can already change their WS address in settings |

Server and Worker are alternative signaling backends. You do not need both, and neither one is itself a TURN relay.

## Use your backend without deploying a frontend {#signaling-only}

1. Deploy a [Server](backend.md) on a host you manage, or a [Worker](worker.md) on Cloudflare. Obtain a WSS endpoint reachable from every participating device, such as `wss://signal.example.com`.
2. Open [webl.ink](https://webl.ink) or an existing [desktop app](../guide/desktop.md). In **Settings → Connection → WebSocket signaling server**, enter that endpoint.
3. Make the same change on the other devices, then rejoin using the same room ID and password. A saved client setting takes precedence over the website or package default; Reset restores that default.
4. Test messages and file transfer. If your networks require relaying, configure TURN as described below.

This changes the signaling service used by the existing client. It does not require rebuilding the frontend or reinstalling the desktop app. The website must still be reachable to load the browser client; deploy your own Web frontend if you also want to control that entry point.

Public HTTPS clients need WSS with a valid certificate. Packaged desktop clients require WSS for non-loopback addresses, including LAN hosts. Use a hostname or IP reachable from each device, not a Docker service name or another computer's `localhost`.

## Decide whether you need STUN or TURN {#stun-and-turn}

| Service             | Role                                                                                      | Carries file or media traffic?                                 |
| ------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| WebSocket signaling | Room discovery and connection negotiation                                                 | No; exchanging connection information does not relay peer data |
| STUN                | Helps a device discover its public-facing address for direct connectivity                 | No                                                             |
| TURN                | Provides a relay when the devices cannot connect directly, or relay-only mode is selected | Yes, for connections that use the relay                        |

STUN cannot guarantee a direct connection through every NAT or firewall. TURN provides another path when direct connectivity is unavailable; background information is in the [WebRTC TURN guide](https://webrtc.org/getting-started/turn-server). Using your own signaling backend does not require running your own STUN/TURN: use existing reachable services or deploy them separately.

Choose endpoints based on access from both devices' networks. For mainland China users, verify the actual carrier/network paths; a particular hosting platform or custom domain does not by itself guarantee reachability. TURN location, bandwidth, and traffic allowance affect relay performance and cost.

### Connect an existing STUN/TURN service {#ice-configuration}

In **Settings → Connection**, add STUN and TURN entries to their respective lists. In bulk editing, use one entry per line. Replace these example addresses and credentials with your own.

STUN usually needs only its URL:

```text
stun:stun.example.com:3478
```

For TURN with a username and password, use `URL|username|password|longterm`. Only add transports and ports that your service actually provides:

```text
turn:turn.example.com:3478?transport=udp|user|password|longterm
turns:turn.example.com:5349?transport=tcp|user|password|longterm
```

Here, `turns:` uses TLS. These are ICE server URLs, not WebSocket URLs; enter them in STUN/TURN settings rather than the WS field. Configure working entries on the participating clients and reconnect. Unlike signaling, they do not have to use the same ICE server, but each client must be able to reach the services it uses.

Provider-issued temporary usernames and passwords can also be entered as `longterm`, but must be replaced when they expire. See [connection settings](../guide/connection.md#ice-servers) for authentication choices and availability checks.

### Use a managed TURN service {#managed-turn}

A managed provider runs the relay for you. Weblink's Server and Worker have built-in integration for Cloudflare TURN: configure `TURN_KEY_ID` and `TURN_KEY_API_TOKEN` on the backend, then clients using that signaling endpoint automatically fetch and refresh temporary credentials from its `/turn-credentials` route. This also works with the existing website or desktop app; no frontend build is needed.

Keep the provider key and API token on the backend. Clients receive temporary credentials, not the key used to issue them, as described in [Cloudflare's credential guide](https://developers.cloudflare.com/realtime/turn/generate-credentials/). Weblink configuration is covered in [Server TURN settings](backend.md#turn) and [Worker TURN settings](worker.md#turn). Other providers can be used through their supplied TURN URLs and client credentials; their credential APIs are not automatically integrated by these two settings.

### Run your own STUN/TURN service {#self-hosted-turn}

[coturn](https://github.com/coturn/coturn) is an open-source STUN/TURN server that can provide both services. Deploy it separately from Weblink signaling, either on the same host with sufficient capacity or on another reachable host. Before deploying, prepare:

- A reachable server address. Behind NAT, configure the advertised public address and matching port forwarding.
- Listening ports: commonly 3478 for UDP/TCP, and 5349 for TLS when enabled. Also allow the configured UDP relay port range through the firewall, security group, and NAT; opening only the listening port is insufficient.
- TURN authentication and a realm, with user credentials or a service that issues temporary credentials. Configure a certificate when offering `turns:`.
- Bandwidth and traffic limits appropriate for relayed files and media, plus credential management and service monitoring.

The available options are documented in the [coturn configuration example](https://github.com/coturn/coturn/blob/master/examples/etc/turnserver.conf) and [server manual](https://github.com/coturn/coturn/wiki/turnserver). Follow those for your operating system or container environment. An ordinary HTTP reverse proxy does not provide TURN's UDP/TCP listeners or relay ports; plan that network access separately from the WSS proxy.

## Verify the setup from your users' networks {#verify}

1. Join from two devices using the same signaling endpoint. Confirm member discovery, then send a message and a file.
2. Run **Check availability** for the configured STUN/TURN services from each network. This checks service access; still verify an actual device-to-device transfer.
3. To verify TURN specifically, enable relay-only mode with valid TURN credentials, reconnect, and test a transfer or video. Restore your preferred mode afterward; leaving it enabled makes all connections depend on TURN.
4. Repeat from the networks you intend to support, such as home Wi-Fi, mobile data, and office networks. Verify the actual relay throughput when large files or screen sharing matter.

If a service is unreachable or a peer connection fails during verification, find the matching steps in the [connection FAQ](../guide/faq.md#connection).
