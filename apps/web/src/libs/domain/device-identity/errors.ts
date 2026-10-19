/** Only invalid remote protocol/proofs quarantine a device. Local I/O and
 * transport failures withdraw live authority while retaining saved trust. */
export class InvalidIdentityProof extends Error {}
