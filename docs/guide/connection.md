---
description: Change signaling servers, configure STUN and TURN, verify a new connection, and measure throughput between two devices.
---

# Connection settings and speed tests

Start with the site's default settings. Use this guide when connecting to your own service, changing the network path, or measuring a connection between two devices.

## Know which setting to change {#before-you-start}

| Setting                    | What it controls                               | When you need it                                          |
| -------------------------- | ---------------------------------------------- | --------------------------------------------------------- |
| WebSocket signaling server | Room discovery and connection setup            | Use another signaling service or your own backend         |
| STUN servers               | Discovery of reachable network addresses       | Configure address discovery for your network              |
| TURN servers               | Relaying when a direct path is unavailable     | Provide a relay for networks that cannot connect directly |
| Peer speed test            | Throughput on an established WebRTC connection | Measure the current path after the devices connect        |

A reachable signaling service does not guarantee a working peer connection. Start by confirming both devices can [join and exchange a message](rooms.md#join).

Before switching services, record the current configuration and finish transfers or recordings that should not be interrupted. **Settings** is available from the avatar's **Account menu**.

## Choose a signaling server {#signaling}

1. Obtain the full WebSocket address of your service, for example `wss://signal.example.com`.
2. **On each device**, open **Settings → Connection → WebSocket signaling server**.
3. Replace the address and check that no validation error remains. Valid edits save automatically.
4. Leave the current room and reconnect. The new address applies to the next connection, not the already-open one.
5. Join with the same room ID and password on both devices, then send a message and a small file to confirm the connection.

**Success means:** both devices find each other through the selected server and can exchange content. Changing only one device's server puts the devices on different services, even if the room IDs match.

Use a full `ws://` or `wss://` URL without embedded login credentials, a fragment, or `room`/`pwd` parameters. HTTPS pages require WSS for remote services; use WSS for public services from desktop too. `localhost` and `127.0.0.1` refer to the device making the connection, not another computer.

To return to the site's default, choose **Reset**, then leave and reconnect. You can connect the existing website or desktop app to your own signaling service without deploying a frontend; see the [self-hosting overview](../deployment/overview.md).

## Add STUN and TURN servers {#ice-servers}

Open **Settings → Connection**. Configure entries using addresses and credentials supplied by your service operator.

1. In **STUN Servers** or **TURN Servers**, enter one item and press **Enter** or choose **Add**.
2. To change an existing item, select its tag, edit it, and save. For several entries, use **Bulk edit**, put one entry on each line, then choose **Save**.
3. Run **Check Availability** for the configured list on each device's current network.
4. Re-establish the peer connection after changing entries, then exchange a message and file again.

A STUN entry uses this syntax; use a service you have confirmed is reachable:

```text
stun:stun.l.google.com:19302
```

A TURN entry contains the address, username, password, and authentication method, separated by `|`. Replace the example values with your own:

```text
turn:turn.example.com:3478|user|password|longterm
```

| Authentication method | What to enter                                                                                                                                           |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `longterm`            | The TURN username and password issued by the operator; temporary credentials also use this mode until they expire                                       |
| `hmac`                | A shared signing secret in the password field, used by the client to generate temporary credentials; only use it on clients trusted to hold that secret |

Provider API keys are not TURN passwords and do not belong in these fields or public frontend builds. If the site's backend provides Cloudflare TURN, the app obtains temporary credentials automatically; ordinary users do not enter provider keys.

**Check Availability** tests the listed service from the current device. A successful check does not prove that the two devices can exchange data or that they actually use TURN. Confirm the newly established connection as described below. UDP/TLS examples and self-hosting requirements are in the [STUN/TURN overview](../deployment/overview.md#stun-and-turn).

## Choose whether to require a relay {#relay-only}

Leave **Settings → Advanced → Relay Only** off for normal direct-or-relayed operation.

If you need to test or require a relay path:

1. Confirm an available TURN service is configured manually or supplied by the backend.
2. Turn on **Relay Only** and reconnect the devices.
3. Open the target device's **Client settings → Session**, inspect **Candidate Route**, and confirm the path uses a relay. Test a message or file as well.
4. To allow direct paths again, turn it off and reconnect.

Relay-only mode requires working TURN credentials and reachability. It cannot repair a missing or unusable relay, and may block a connection that otherwise could have been direct.

## Share connection settings deliberately {#share-settings}

The room invitation includes room information, but **does not include a custom WebSocket URL**. Tell the other person which signaling service to select separately.

**Settings → Connection → Share Servers with Others** can include configured STUN/TURN entries in generated invitations, including TURN credentials. Enable it only when you intend to give those entries to the recipient. Turning it off affects newly generated links; it does not remove information from links already copied.

## Test the current connection {#speed-test}

1. **On both devices**, join the same room, wait for connection and pairing, and confirm a message arrives. Finish or pause file transfers and pause calls to reduce interference.
2. **On the initiating device**, open the target member's private chat, select **Client settings** in the conversation header, then open **Speed test**.
3. Choose **Start speed test**.
4. **On the other device**, choose **Allow test** in the approval request. You can also handle the request through **Account menu → Tasks**.
5. Wait for **This device → peer** and **Peer → this device** to finish. Read both results, or choose **Stop test** to end early.

**Success means:** the test completes with results for both directions. It sends real traffic for up to **10 seconds or 64 MiB per direction**, whichever comes first: at most 128 MiB of payload in total, plus protocol overhead. If the current path is relayed, this also uses TURN traffic. It does not create a file in the library.

Closing client details or changing tabs does not stop an active test. Use **Tasks** to view it or stop it. Leaving the room or losing the peer connection also ends the test.

## Interpret and compare results {#results}

The results are average payload throughput confirmed by the receiver on the current WebRTC path. They exclude file reading, compression, and disk writes; they are neither your broadband plan's speed nor a guarantee of file-saving speed.

| What you see                                    | How to use it                                                                        |
| ----------------------------------------------- | ------------------------------------------------------------------------------------ |
| Different speeds in the two directions          | Read each direction separately; each device's network and processing load can differ |
| A test reaches the byte limit in under a second | Repeat and compare; a very short sample may be less stable                           |
| Actual file transfers are slower than the test  | Also account for file access, compression, storage writes, and other workload        |
| A browser bitrate estimate in the Session tab   | Treat it as an estimate, not the measured result from Speed test                     |

For comparisons, keep both devices in the foreground, use the same networks, and reduce other transfers or calls. After changing STUN/TURN or relay-only settings, reconnect before comparing the new path.

## Choose your next step {#troubleshooting}

- **Choose which services to run yourself:** follow the [self-hosting overview](../deployment/overview.md).
- **Joining is slow or fails from mainland China:** use the [signaling reachability checks](faq.md#signaling-mainland).
- **Members appear but messages, files, or media do not connect:** follow the [WebRTC connection checks](faq.md#peer-connection).
- **Understand how discovery and reconnection work:** read [signaling and session recovery](../architecture/signaling.md).
