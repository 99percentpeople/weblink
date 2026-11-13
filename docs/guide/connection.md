# Connection settings and speed tests

The site's default connection settings are usually enough. Adjust them when using self-hosted signaling, resolving cross-network connection problems, or measuring the current link.

## Choose a signaling server {#signaling}

Open **Settings → Connection → WebSocket signaling server** and enter an address reachable by the browser or desktop, such as `wss://signal.example.com`. Valid edits save automatically and apply when you rejoin the room. “Reset” restores the site's default.

All devices in a room must use the same endpoint. HTTPS pages and packaged desktop apps should use WSS for public services. Other devices cannot use your computer's `localhost` or `127.0.0.1` as their destination.

You can use your own signaling service from the existing website or desktop app without deploying a frontend. Start with the [self-hosting overview](../deployment/overview.md) to choose the components you need.

## Configure STUN and TURN {#ice-servers}

STUN helps devices discover reachable network addresses; TURN relays data when a direct connection is unavailable. A working signaling server does not prove that the network permits direct device connections.

Add or edit server entries in connection settings, one per line in bulk editing. Example STUN entry:

```text
stun:stun.l.google.com:19302
```

For an existing TURN service, use your own address and credentials:

```text
turn:turn.example.com:3478|user|password|longterm
```

The TURN fields are address, username, password, and authentication method. Supported methods are `longterm` and `hmac`. Use “Check availability” to test configured services from the current network.

`longterm` uses the supplied username and password for TURN authentication; provider-issued temporary credentials also use this mode until they expire. In `hmac` mode, the password field is a shared signing secret used by the client to generate temporary credentials. Use it only on clients you trust with that secret; keep provider API keys out of these fields and public frontend builds.

For UDP/TLS URL examples, managed services, and the requirements for running coturn, see the [STUN/TURN deployment overview](../deployment/overview.md#stun-and-turn).

When the site's backend provides Cloudflare TURN, the frontend fetches temporary credentials automatically; users do not enter provider keys here. See [Server TURN settings](../deployment/backend.md#turn) or [Worker TURN settings](../deployment/worker.md#turn) for self-hosting configuration.

Relay-only mode in advanced settings requires a working TURN service. Enabling it without a relay blocks connections that could otherwise be direct. Re-establish connections after changing network settings to verify the result.

## Test the current device connection {#speed-test}

1. Join the same room as the target device and wait for connection and pairing.
2. Open the Speed test tab in member details and start a test.
3. After the other device approves, upload and download are measured in sequence.
4. Review the results, or use Stop to end the test.

Testing sends real traffic: up to 128 MiB of payload across both directions, plus protocol overhead. A connection using TURN also sends test traffic through the relay. It does not create a test file in the library.

Closing member details does not stop an active test. Stopping, leaving the room, or losing the connection ends it.

## Interpret the results {#results}

Results measure application throughput on the current WebRTC path, not your broadband plan or actual file-saving speed. Disk writes, compression, background tabs, other transfers, and device load affect the experience.

For comparisons, keep network, foreground state, and load similar.

## Choose your next step {#troubleshooting}

- **Run signaling on a server you manage:** follow [Server deployment](../deployment/backend.md).
- **Have Cloudflare host your signaling backend:** follow [Worker deployment](../deployment/worker.md).
- **Understand how joining and reconnects work:** follow the [signaling handshake and session recovery](../architecture/signaling.md).
- **Joining is slow or fails from mainland China:** follow the [signaling reachability checks](faq.md#signaling-mainland).
- **Members appear but data cannot connect:** follow the [WebRTC connection checks](faq.md#peer-connection).
