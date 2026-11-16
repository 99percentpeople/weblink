---
description: Change your signaling service, configure a relay when needed, or test an existing connection.
outline: 2
---

# Connection settings and speed tests

### Before changing settings {#before-you-start}

Keep the site's defaults for ordinary use. Open **Settings** from the avatar's **Account menu** when you need another server or relay. The WebSocket service helps devices find each other; their data connection is separate.

## Change the signaling server {#signaling}

1. On **each device**, open **Settings → Connection → WebSocket signaling server** and enter your service's full address, such as `wss://signal.example.com`. Valid edits save automatically.
2. Leave the room and reconnect to apply the change. Both devices must use the same server, room ID, and password.
3. Send a message to confirm the new connection. **Reset** restores the site's default for the next connection.

Reconnecting interrupts the live session, so finish needed transfers and recordings first. You can use your own signaling service with the existing website or desktop app.

::: details Address requirements and invitations

Use a full `ws://` or `wss://` URL without embedded credentials, a fragment, or `room`/`pwd` parameters. HTTPS pages require WSS for remote services; use WSS for public desktop connections too. `localhost` and `127.0.0.1` refer to the connecting device.

### Share connection settings {#share-settings}

Invitations do not include a custom WebSocket URL; tell the recipient which server to select.

**Share Servers with Others** in connection settings can include STUN/TURN entries and credentials in newly generated links. Enable it only when you intend to share those details. Turning it off does not retract links already copied.
:::

## Configure STUN or TURN when needed {#ice-servers}

STUN discovers reachable addresses; TURN relays data when direct connection is unavailable.

In **Settings → Connection**, add an entry under **STUN Servers** or **TURN Servers** and press **Enter**. To edit, select its tag; **Bulk edit** accepts one entry per line followed by **Save**.

Run **Check Availability**, then reconnect the devices and try a message or file. A successful service check alone does not confirm the device-to-device connection.

::: details Server entry formats and credentials

A STUN entry uses this syntax; choose a service reachable from your network:

```text
stun:stun.l.google.com:19302
```

For TURN, replace the address, username, and password with your service's values:

```text
turn:turn.example.com:3478|user|password|longterm
```

- `longterm`: use the operator's username and password, including temporary credentials until they expire.
- `hmac`: the password field is a shared signing secret used to generate temporary credentials. Only use it on clients trusted to hold the secret.

Provider API keys are not TURN passwords. When the backend provides Cloudflare TURN, clients obtain temporary credentials automatically. For transport options and hosting, see the [STUN/TURN overview](../deployment/overview.md#stun-and-turn).
:::

::: details Require a relay instead of allowing direct connections

### Relay-only mode {#relay-only}

First confirm a working TURN service is configured or supplied by the backend. Enable **Settings → Advanced → Relay Only**, reconnect, then inspect **Client settings → Session → Candidate Route** and test content delivery.

**Relay-only mode cannot work without a usable TURN service.** To allow direct connections again, turn it off and reconnect.
:::

## Test the current connection {#speed-test}

1. With both devices connected, open the target member's private chat, then **Client settings → Speed test → Start speed test**.
2. The other device chooses **Allow test** in the request or **Account menu → Tasks**.
3. Wait for both directions to finish, or choose **Stop test**. Results measure this connection, not your broadband plan or disk-saving speed.

**The test sends up to 128 MiB of payload in total, plus overhead**, including TURN traffic if relayed. Finish or pause file transfers and calls first. Closing the dialog does not stop the test; use **Tasks** to stop or view it.

::: details Interpret the results and compare networks

### What the numbers mean {#results}

Each direction sends for up to 10 seconds or 64 MiB, whichever comes first. Results are average received payload throughput, excluding file reading, compression, and disk writes. No test file is saved.

Directions can differ. Repeat very short samples; keep devices in the foreground with similar network and load conditions. Reconnect after changing server or relay settings before comparing paths.

The Session tab's browser bitrate estimate is not a measured speed-test result. Leaving the room or losing the connection ends a running test.
:::

## Choose your next step {#troubleshooting}

- **Run your own services:** start with the [self-hosting overview](../deployment/overview.md).
- **Joining is slow or fails:** use the [signaling reachability checks](faq.md#signaling-mainland).
- **Members appear but data does not connect:** follow the [WebRTC connection checks](faq.md#peer-connection).
