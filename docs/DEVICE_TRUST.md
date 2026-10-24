# Device pairing and content permissions

Each local browser profile or desktop WebView profile owns an ECDSA P-256
private key in IndexedDB for signaling ownership and connection binding.
Web Crypto is preferred and creates non-extractable native keys, checking
public-key export and signing support before persisting a newly generated pair. When an API
or algorithm is unavailable (including LAN HTTP), a lazily loaded Noble
implementation provides P-256, SHA-256 and HMAC-SHA-256 with the same public-key,
signature and credential formats. Software key bytes are stored in the same
profile's IndexedDB and can also be used by Web Crypto when it becomes available.
Randomness always comes from `crypto.getRandomValues`. Invalid data and failed
verification do not trigger fallback. Existing non-extractable native keys are
preserved if Web Crypto becomes unavailable; they cannot be converted or silently
replaced. This compatibility does not make HTTP a secure context for other browser APIs.

Paired devices also issue a pairing key to each other. These are the
credentials used directly for peer authentication, not separate recovery tokens.
Device identity is independent of account identity, local MCP bearer tokens, and
temporary automation scope grants. There is no SSO or account-wide trust propagation.

The dedicated ordered `weblink-device-identity/1` RTC channel exchanges public
keys and proves possession by signing both device IDs, fresh challenges and
both connections' DTLS certificate fingerprints. Initial pairing records a
SHA-256 public-key fingerprint; subsequent connections prove possession of an
exchanged pairing key against the same fresh transcript. Names, client IDs and
knowledge of public keys alone never grant automatic authority.
On first use, a device with no saved pin, pairing keys or quarantine record is
automatically paired after its fresh signed proof is verified and its pin is
stored. Peers include their pairing-history state in the signed
transcript. If either side remembers a shared-key exchange or quarantine,
a side without any local records cannot treat this as first use: both sides
need a surviving common key, verified identity recovery, or explicit repair.
A matching pin saved before the initial key exchange can still resume that
interrupted exchange. Pairing-key connections require the signed history and
identity-recovery negotiation; missing negotiation fields never enable a fallback.
Initial admission relies on room access (including its password when configured)
and trusts the first verified key encountered. Later automatic connections must
prove continuity with that saved identity.

Manual repair uses a separate ordered `weblink-device-pairing/1` RTC channel.
One device requests pairing; the other explicitly accepts or rejects in a
notification or the device's permission settings. There is no comparison code
or private-key challenge before this approval, so a failed automatic identity
handshake does not prevent manual repair. Acceptance replaces the saved identity
decision for this connection; it is not automatic proof of the old identity.
The public keys exchanged on that connection are pinned for subsequent recovery.
Both devices must save the decision before live permissions are enabled, then
the existing signed credential issuance and renewal flow starts.

Requests are scoped to the current session and a random request ID, and expire
after 60 seconds. Cancellation, rejection, timeout and disconnect invalidate the
approval action. The recipient generates its own local action ID, so reusing a
remote request ID cannot revive an old notification's approval button. A request
alone never changes saved keys or permissions, even
when its recipient is still trusted. Simultaneous or duplicate requests cannot
replace an active request. Automatic proof callbacks from before an accepted
manual repair cannot overwrite it. Reconnect and automatic recovery still require
the existing fresh identity/shared-key proofs; manual confirmation adds no
automatic fallback for an impostor.

Without a surviving verifiable pairing key or verified identity recovery,
a mismatching identity or invalid remote proof leaves the device **untrusted**. The signaling and
RTC connections remain available for discovery and pairing. All application
permissions are denied; current transfers, clipboard activity, input and peer
automation are cancelled. Existing permission choices are reset when a device
is quarantined. A persistent in-app warning opens that device's permission
settings; it never grants permissions itself. Repeated state updates do not
repeat the warning, and repair or disconnection dismisses it.
A remembered key that has been quarantined cannot automatically
restore trust on a later reconnect. Explicit pairing replaces the pin and
restores the default permissions, as does automatic first pairing: receive content,
share screen and provide file list are on; remote control and automation ask for
approval. This does not start screen capture or bypass OS capture consent.
Key storage must succeed
before the device is trusted. Normal disconnection, handshake deadlines and local
storage/transport errors withdraw live authority without quarantining the remembered
key or erasing saved permissions, including before verification completes. The
initiating device retries the handshake while the message channel is available.
Reconnection requires a fresh proof before saved device permissions can apply again.

## Pairing keys and automatic renewal

After both devices establish trust, each generates its own independent 256-bit
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

Every pairing key requires an issuer signature. It binds the key
ID, expiration and SHA-256 secret hash to both device IDs and both identity
public keys. This is public metadata on the existing credential, not a new
token or a copy of an identity private key. When a surviving shared key
authenticates a regenerated signing identity, normal maintenance rebinds the
pairing keys to that identity. Pending offers retain their secret through
this process so a lost ACK never discards the pending key.

If a device loses all peer records but retains its original identity keypair,
the remembering device verifies the fresh connection signature against its saved
pin. In the other direction, the remembering device presents the signed binding
on the key previously issued by the forgetful device. The forgetful device
verifies its own original signature and requires the recipient identity in that
binding to match the peer's fresh connection proof. A retained local issuance
can likewise restore a missing peer pin. A conflicting current pin takes
precedence over a historical binding. Neither device trusts an assertion that
the other device remembers it, and historical bindings alone cannot authenticate
another device or replay a connection signature.

Identity recovery is an explicit, signed negotiation: at least one side must
have no pairing keys, neither may advertise quarantine, and both must support
the extension. The recovery states join the same nonce/DTLS-bound transcript.
A malformed binding or incorrect MAC for a known key is a verification failure,
never a reason to fall back to identity recovery. No recovery secret is sent in
the proof. After verification and durable pin storage, the existing issuance
and ACK flow restores the missing keys without resetting permission choices.
Interrupted recovery and failed storage writes remain retryable with live
application access gated as appropriate.

If the identity keypair was also lost and no common pairing key survives,
explicit repair is required. If both pins remain, identity recovery can
replace missing keys even when neither side retains an issuance.
The pairing-key format is under development; unsigned keys and peers that
omit the identity-binding negotiation are not supported.

The default renewal interval is 90 days, measured by the issuer's clock. Expiry
is a renewal deadline, not an offline revocation: the previous key remains valid
for a fresh proof until replacement completes. The issuer renews on reconnect
or when the deadline arrives during a connection. It persists a pending key
before sending it; the recipient persists it before acknowledging. Only that
acknowledgement retires the old issuance. A lost acknowledgement, restart or
failed storage write preserves the old/pending material and retries the same
pending key. Successful automatic maintenance never resets permissions.

Once pairing keys are enabled for a peer, its public pin cannot bypass a missing
or invalid pairing-key proof outside the explicitly negotiated identity recovery
path. Omitting either extension cannot enable that path.
Confirmed public pins can resume the first exchange; no exchange starts before
local trust and peer consent. An undelivered
first offer remains resumable using the pinned signing identity.
Receipt of a key or acknowledgement of an issuance atomically makes pairing-key
authentication (or verified identity recovery) mandatory alongside persisting
that key. Removing the keys later
never clears this requirement. Explicit re-pairing atomically records the new
confirmation and removes prior pairing keys. A connection lost during that commit
cannot activate stale live authority or revoke the valid saved confirmation. Explicitly
quarantined keys cannot recover automatically. Manual re-pairing clears old
pairing keys and restores default permissions, never previous permanent grants.
If neither a shared key nor the original bound identity can be verified,
manual re-pairing remains necessary. Expiry does not provide a hard
revocation deadline; explicit quarantine/re-pairing revokes the prior keys.

The per-device settings are:

- **Receive content:** one switch gates all incoming application content:
  messages, profiles, files, file lists, clipboard, audio/video, speed tests,
  remote operations and automation. Only transport, capability discovery and
  identity/pairing traffic remain available when it is off. Turning it off
  closes application channels and cancels pending requests. Media disappears
  immediately from application views and recording sources. Receiver tracks are
  disabled and can be reused when reception is enabled again; the sender also
  withdraws its media after the reception capability update. This cannot prevent
  a malicious peer from sending packets to an established network transport.
- **Share screen:** controls publication of local screen/camera and audio to this
  device, including native screen publications. Remote screen/control automation
  also requires this permission. Closing it interrupts peer automation so an
  already approved screen operation cannot retain its old grant.
- **Remote control:** ask, permanently allow, or deny. Receive content and share
  screen must both be enabled. The stored policy is usable only for a device
  that has proved its paired identity.
- **Provide file list:** controls the shared file catalog in addition to the
  reception gate. It is enabled in the default permission set.

File transfers, control, clipboard and native streaming use duplex protocols;
turning reception off also interrupts these exchanges when this device was the
initiator. Local MCP tokens remain usable according to their own rules and are
not issued, changed or revoked by remote-device pairing.

## Duplicate IDs and signaling deployment

Both Bun signaling and the Cloudflare Worker issue a fresh WebSocket challenge.
A join proof signs the challenge, client ID and creation time. A room member
with a verified signing key can be replaced/resumed only by a valid proof with
the same public key. Unsigned, wrong-key or replayed duplicate joins cannot
replace that member or close its socket. The rejected duplicate candidate waits with
capped exponential backoff and fresh join proofs, including when it has never
joined successfully. Transient transport failures during that wait keep retrying;
leaving the room cancels the wait. No retry sends a leave or overrides the current
owner. Only after the signed membership/lease is gone can a different signing key
join that ID. An already admitted session that is explicitly replaced still stops
retrying, preventing takeover loops. This protects the currently
admitted device; the server cannot establish ownership of an unused ID before
its first admission. Endpoint pairing remains necessary.

An unsigned legacy member retains the old same-ID replacement and resume
behavior, including cached signaling during the disconnect grace period.
Legacy clients can communicate with each other without implementing identity
proofs. A supplied invalid proof is rejected rather than treated as legacy.
A valid signed replacement upgrades an unsigned member; later unsigned joins
cannot downgrade or replace it. Unsigned members retain the old protocol's
limitations against ID impersonation.

Bun deployments using Redis reserve a room/client lease atomically across nodes.
A signed live lease on another node is conservatively rejected even for a matching
key. Use sticky routing for signed reconnects. Unsigned leases can move between
nodes for legacy reconnects; the previous transport is retired without emitting
a stale leave or releasing the new lease. A different node acknowledges a fresh
join so the client rebuilds its signaling state. After a node fails, another node can admit
the ID when the lease expires (heartbeat timeout + disconnect grace + heartbeat
interval + 10 seconds). Redis failure denies admission and forwarding rather
than bypassing ownership checks. Deploy the updated server to every node before
relying on this protection; mixed versions do not share the admission boundary.

Old clients can join and resume unsigned membership but cannot pass device pairing,
exchange application content with new clients, or replace a signed member without
a matching proof. An old signaling server does not protect against duplicate-ID eviction.
Use HTTPS/localhost or the desktop secure origin for persistent WebCrypto keys.
Clearing all profile storage removes both directions of pairing keys. That
profile treats peers as new; any peer retaining the old identity still requires
manual re-pairing when no shared key survives. Restoring peer trust after partial identity loss
does not bypass signaling ownership: a different signing key cannot evict a
currently connected member with the same ID. It must wait for the prior member
to leave or its lease to expire; the client retries automatically while waiting.
Pairing-key renewal leaves that signaling key
unchanged. There is no key backup/export UI.
