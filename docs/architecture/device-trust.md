# Device identity and authorization

Weblink separates room membership, device identity, and permission to act. Discovering a peer does not prove it is a previously paired device, and proving its identity does not authorize every operation. The destination device makes its own access decisions.

## Local identity and connection binding {#identity}

Each browser profile or desktop WebView profile owns an ECDSA P-256 identity keypair stored in IndexedDB. It is a local device identity, not an account login. The same device name in another browser does not reproduce that keypair or inherit its permissions.

The ordered `weblink-device-identity/1` RTC channel exchanges public keys and fresh proofs. The signed transcript binds the connection to several values:

| Bound value                        | Purpose                                                             |
| ---------------------------------- | ------------------------------------------------------------------- |
| Both device IDs and public keys    | Identify the two parties to this exchange                           |
| Fresh challenges                   | Prevent a previous connection's proof from being replayed           |
| Both DTLS certificate fingerprints | Bind the identity exchange to this transport connection             |
| Pairing-history and recovery state | Prevent a forgotten record from silently being treated as first use |

Knowing a public key, reusing a client ID, or copying a display name is not proof of the corresponding private key. The signing private key is never sent to the other device.

Web Crypto creates non-extractable native keys when supported. When the required API or algorithm is unavailable, the compatible software implementation stores key bytes in the same local profile and uses the same public formats. Randomness still comes from `crypto.getRandomValues`. Invalid proofs do not trigger that fallback, and an existing non-extractable key is not silently replaced when its native API becomes unavailable.

## First pairing and reconnect proofs {#pairing}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="Device identity verification and authorization flow" tabindex="0">

![A connection verifies identity before saving trust and checking operation permissions. Invalid proof quarantines the relationship and cancels protected activity. Explicit pairing can establish a new saved decision, after which scoped permissions still govern operations.](/diagrams/device-trust-en.svg)

</div>
<figcaption>Identity verification and operation authorization are separate stages. The failure branch represents invalid identity proof; ordinary connection timeouts do not quarantine the remembered identity.</figcaption>
</figure>

On first use, with no saved pin, pairing key, or quarantine record, a valid fresh signed proof can establish automatic pairing. The peer's public-key fingerprint is pinned using SHA-256, and the decision must be saved before the device becomes trusted.

This is trust on first use. Room admission, including its password when configured, helps control who reaches that first exchange; automatic pairing does not independently verify a person's real-world identity. A remembered pairing history prevents a returning device with missing local records from simply claiming to be a new first encounter.

After trust is established, both devices independently issue a random 256-bit pairing key to each other over the verified connection. Each side keeps the verification material for the key it issued and the received key from its peer.

Reconnects use HMAC-SHA-256 proofs over fresh connection-bound data, rather than sending the shared secret as the proof. The protocol checks continuity with the saved pairing relationship before reapplying remembered permissions.

## Recovery and explicit repair {#recovery}

Pairing records have separate pins, issued keys, and received keys. If a matching shared key survives on both devices, the connection can authenticate and restore missing identity or issuance records. Some identity-record loss can also be recovered through a retained signing identity and verified signed credential bindings. A claim that the other side remembers the device is not sufficient.

Recovery must be supported and cryptographically verified. A malformed proof, an incorrect MAC for a known key, or quarantine state cannot be used as a reason to downgrade to first-use trust. Losing all usable verification material can require explicit pairing again.

Manual repair uses a separate ordered `weblink-device-pairing/1` RTC channel. One device requests pairing and the other accepts or rejects. The request is bound to the current session and a random request ID, and expires after 60 seconds. Cancellation, disconnection, and expiry invalidate its approval action; an old notification cannot authorize a later connection.

Acceptance establishes a new identity decision for that connection. It does not prove that a replacement identity is the old one. Both devices save the decision before live permissions are enabled, then resume normal credential issuance. Manual repair restores default permissions rather than silently preserving elevated grants.

## Verification failure and normal disconnection {#failure-states}

| Event                                                                          | Effect                                                                                                                           |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| Invalid identity proof or an unrecoverable identity mismatch                   | Mark the device untrusted and quarantine the remembered relationship; deny application permissions and cancel protected activity |
| Ordinary disconnection, handshake deadline, or local transport/storage failure | Withdraw live authority while preserving remembered identity and permission choices                                              |
| Reconnect                                                                      | Require a fresh proof before saved permissions can apply                                                                         |
| Explicit successful repair                                                     | Save the new decision and restore the default permission policy                                                                  |

An untrusted connection can remain available for discovery and manual pairing. That does not allow transfers, clipboard access, input, or peer automation to continue. A warning points to the permission settings; displaying or dismissing the warning does not grant access.

## Identity is not an operation grant {#authorization}

After pairing, the target checks the permission category for the requested operation. Default policy enables receiving content, providing a shared file list, and screen sharing; remote control and automation ask for approval. Enabling screen-sharing permission does not start capture or bypass OS consent.

Authorization also has an active lifetime. Remote control is bound to a peer and source, and automation may need a temporary grant for its operation. Disconnecting, revoking permission, or replacing the owning session must stop the work governed by that authority.

MCP has another authentication boundary: the desktop HTTP token authenticates the MCP client connecting to that endpoint. A forwarded operation still travels through the peer relationship and is checked by the destination device. Possessing a local MCP token is not a substitute for remote device identity or permission.

## Implementation entry points {#implementation}

Paths are relative to `apps/web/src/libs/`:

| Path                                                                                    | Responsibility                                                 |
| --------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `domain/device-identity/handshake.ts`, `domain/device-identity/crypto.ts`               | Fresh connection proofs and cryptographic operations           |
| `domain/device-identity/credentials.ts`, `domain/device-identity/credential-binding.ts` | Pairing keys, signed bindings, and renewal                     |
| `domain/device-identity/manual-pairing.ts`                                              | Explicit pairing request lifecycle                             |
| `infrastructure/identity/device-identity-store.ts`                                      | Local identity and pairing persistence                         |
| `application/peer-trust.ts`                                                             | Trust state, quarantine, recovery, and live permission effects |

## Choose your next step {#next-steps}

- **Pair a device or change what it may access:** follow [device pairing and permissions](../guide/device-trust.md).
- **Connect an assistant to the desktop endpoint:** use the [MCP and automation guide](../guide/automation.md).
- **Understand how capabilities differ from authorization:** read [P2P capability negotiation](p2p-protocol.md#capabilities).
