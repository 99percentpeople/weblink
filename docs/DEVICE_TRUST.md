# Device pairing and content permissions

Each local browser profile or desktop WebView profile owns a non-extractable
ECDSA P-256 private key in IndexedDB for signaling ownership and connection
binding. Paired devices also issue a pairing key to each other. These are the
credentials used directly for peer authentication, not separate recovery tokens.
Device identity is independent of account identity. There is no SSO or
account-wide trust propagation.

The dedicated ordered `weblink-device-identity/1` RTC channel exchanges public
keys and proves possession by signing both device IDs, fresh challenges and
both connections' DTLS certificate fingerprints. Initial pairing records a
SHA-256 public-key fingerprint; subsequent connections prove possession of an
exchanged pairing key against the same fresh transcript. Names, client IDs and
knowledge of public keys alone never grant authority.
The UI displays a fresh 16-hex-digit pairing code on both devices, including
when one device already trusts the other. Compare it through a trusted channel
or directly on both screens before confirming pairing on each unpaired side.

A new device starts **unpaired**. Without a surviving verifiable pairing key,
a mismatching identity or invalid remote proof leaves the device **untrusted**. The signaling and
RTC connections remain available for discovery and pairing. All application
permissions are denied; current transfers, clipboard activity and input
are cancelled. Existing permission choices are reset when a device
is quarantined. A remembered key that has been quarantined cannot automatically
restore trust on a later reconnect. Explicit pairing replaces the pin and
unlocks settings, with all permissions still off. Key storage must succeed
before the device is trusted. Normal disconnection, handshake deadlines and local
storage/transport errors withdraw live authority without quarantining the remembered
key or erasing saved permissions, including before verification completes. The
initiating device retries the handshake while the message channel is available.
Reconnection requires a fresh proof before saved device permissions can apply again.

## Pairing keys and automatic renewal

After both devices confirm trust, each generates its own independent 256-bit
random shared key and sends it to the other over the verified DTLS channel.
The issuer retains the same key as verification material. Reconnection uses
HMAC-SHA-256 challenge proofs, not transmission of the secret. The proofs bind
both device IDs, fresh nonces, public keys and DTLS fingerprints; they cannot be
reused on another connection or reflected in the opposite direction. The local
ECDSA signing private key is never sent to another device.

The only pairing keys are **issued** and **received**, with a temporary pending
issuance during replacement. Either shared direction can authenticate the
connection. If an issuance record, public pin or local identity keypair is lost
but one matching shared key survives on both devices, they automatically restore
trust, retain permission settings and replace the missing issuance. If the
recipient loses its received copy, its issuer notices this after authentication
and uses the same replacement flow. A partial local identity keypair is
regenerated on load without deleting peer keys. Public pins and issued/received
keys are stored separately so loss of a pin does not delete the received key.

The default renewal interval is 90 days, measured by the issuer's clock. Expiry
is a renewal deadline, not an offline revocation: the previous key remains valid
for a fresh proof until replacement completes. The issuer renews on reconnect
or when the deadline arrives during a connection. It persists a pending key
before sending it; the recipient persists it before acknowledging. Only that
acknowledgement retires the old issuance. A lost acknowledgement, restart or
failed storage write preserves the old/pending material and retries the same
pending key. Successful automatic maintenance never resets permissions.

Once pairing keys are enabled for a peer, its public pin cannot bypass a missing
or invalid pairing-key proof, even if a client omits the key-exchange extension.
Existing confirmed public pins can bootstrap the first exchange between updated
clients; no exchange starts before local trust and peer consent. An undelivered
first offer remains resumable using the explicitly confirmed signing identity.
Receipt of a key or acknowledgement of an issuance atomically makes pairing-key
authentication mandatory alongside persisting that key. Removing the keys later
never clears this requirement. Explicit re-pairing atomically records the new
confirmation and removes prior pairing keys. A connection lost during that commit
cannot activate stale live authority or revoke the valid saved confirmation. Explicitly
quarantined keys cannot recover automatically. Manual re-pairing clears old
pairing keys and leaves permissions off. If no shared secret survives on both
devices, manual re-pairing remains necessary. Expiry does not provide a hard
revocation deadline; explicit quarantine/re-pairing revokes the prior keys.

The per-device settings are:

- **Receive content:** one switch gates all incoming application content:
  messages, profiles, files, file lists, clipboard, audio/video, speed tests,
  remote operations. Only transport, capability discovery and
  identity/pairing traffic remain available when it is off. Turning it off
  closes application channels and cancels pending requests. Media disappears
  immediately from application views and recording sources. Receiver tracks are
  disabled and can be reused when reception is enabled again; the sender also
  withdraws its media after the reception capability update. This cannot prevent
  a malicious peer from sending packets to an established network transport.
- **Share screen:** controls publication of local screen/camera and audio to this
  device, including native screen publications.
- **Remote control:** ask, permanently allow, or deny. Receive content and share
  screen must both be enabled. The stored policy is usable only for a device
  that has proved its paired identity.
- **Provide file list:** controls the shared file catalog in addition to the
  reception gate. Pairing never enables it automatically.

File transfers, control, clipboard and native streaming use duplex protocols;
turning reception off also interrupts these exchanges when this device was the
initiator.

## Duplicate IDs and signaling deployment

Both Bun signaling and the Cloudflare Worker issue a fresh WebSocket challenge.
A join proof signs the challenge, client ID and creation time. An existing room
member can be replaced/resumed only by a valid proof with the same public key.
Unsigned, wrong-key or replayed duplicate joins are rejected without a leave
notification or closing the original socket. The rejected candidate waits with
capped exponential backoff and fresh join proofs, including when it has never
joined successfully. Transient transport failures during that wait keep retrying;
leaving the room cancels the wait. No retry sends a leave or overrides the current
owner. Only after the old membership/lease is gone can a different signing key
join that ID. An already admitted session that is explicitly replaced still stops
retrying, preventing takeover loops. This protects the currently
admitted device; the server cannot establish ownership of an unused ID before
its first admission. Endpoint pairing remains necessary.

Bun deployments using Redis reserve a room/client lease atomically across nodes.
A live lease on another node is conservatively rejected even for a matching key.
Use sticky routing for reconnects. After a node fails, another node can admit
the ID when the lease expires (heartbeat timeout + disconnect grace + heartbeat
interval + 10 seconds). Redis failure denies admission and forwarding rather
than bypassing ownership checks. Deploy the updated server to every node before
relying on this protection; mixed versions do not share the admission boundary.

Old clients can join an unused ID but cannot pass device pairing, exchange
application content with these clients, or replace an existing member without a
proof. An old signaling server does not protect against duplicate-ID eviction.
Use HTTPS/localhost or the desktop secure origin for persistent WebCrypto keys.
Clearing all profile storage removes both directions of pairing keys and
requires manual re-pairing. Restoring peer trust after partial identity loss
does not bypass signaling ownership: a different signing key cannot evict a
currently connected member with the same ID. It must wait for the prior member
to leave or its lease to expire; the client retries automatically while waiting.
Pairing-key renewal leaves that signaling key
unchanged. There is no key backup/export UI.
